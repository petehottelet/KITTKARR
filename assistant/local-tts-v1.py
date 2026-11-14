"""Loopback-only Qwen3 voice service. Models and reference audio stay local."""

from __future__ import annotations

import argparse
from array import array
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import ipaddress
import json
import math
import os
from pathlib import Path
import select
import socket
import sys
import threading
import time
from urllib.parse import urlsplit
import wave


class VoiceError(Exception):
    def __init__(self, code, status=503):
        super().__init__(code)
        self.status = status


@dataclass(frozen=True)
class VoiceConfig:
    model_path: str
    model: str = "qwen-local"
    voice: str = "local"
    speaker: str = "ryan"
    reference_audio: str | None = None
    reference_text: str | None = None

    @classmethod
    def read(cls, filename):
        try:
            data = json.loads(Path(filename).read_text(encoding="utf-8"))
            config = cls(**data)
            if not isinstance(config.model_path, str):
                raise ValueError()
            model_path = Path(config.model_path).expanduser().resolve(strict=True)
            if not model_path.is_dir():
                raise ValueError()
            for name in (config.model, config.voice, config.speaker):
                if not isinstance(name, str) or not name or len(name) > 120:
                    raise ValueError()
            if config.reference_audio is not None or config.reference_text is not None:
                if not isinstance(config.reference_text, str) or not config.reference_text.strip() or len(config.reference_text) > 4000:
                    raise ValueError()
                if not isinstance(config.reference_audio, str) or not Path(config.reference_audio).expanduser().is_file():
                    raise ValueError()
            return config
        except (OSError, TypeError, ValueError):
            raise VoiceError("invalid_configuration") from None


def load_model(config):
    for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY"):
        os.environ[key] = "1"
    from mlx_audio.tts.utils import load_model as load
    return load(str(Path(config.model_path).expanduser().resolve()))


class VoiceRuntime:
    """One model thread, one active request and at most two waiting requests."""

    def __init__(self, config, loader=load_model):
        self.config = config
        self.loader = loader
        self.executor = ThreadPoolExecutor(max_workers=1)
        self.lock = threading.Lock()
        self.ready = False
        self.error = None
        self.model = None
        self.active = False
        self.pending = set()
        self.stopping = threading.Event()

    def prepare(self):
        try:
            self.model = self.loader(self.config)
            self.conditioning()
            self.ready = not self.stopping.is_set()
        except Exception:
            self.error = "model_unavailable"

    def conditioning(self):
        kind = getattr(getattr(self.model, "config", None), "tts_model_type", "base")
        if kind == "custom_voice":
            return {"voice": self.config.speaker}
        if kind != "base" or not self.config.reference_audio or not self.config.reference_text:
            raise VoiceError("reference_required")
        return {"ref_audio": str(Path(self.config.reference_audio).expanduser().resolve()), "ref_text": self.config.reference_text}

    def state(self):
        with self.lock:
            return {"ready": self.ready, "active": self.active, "queued": max(0, len(self.pending) - int(self.active)), "error": self.error}

    def submit(self, text, cancel):
        with self.lock:
            if not self.ready or self.stopping.is_set():
                raise VoiceError("not_ready")
            if len(self.pending) >= 3:
                raise VoiceError("busy", 429)
            self.pending.add(cancel)
        try:
            future = self.executor.submit(self.generate, text, cancel)
        except RuntimeError:
            self.release(cancel)
            raise VoiceError("not_ready") from None
        future.add_done_callback(lambda _: self.release(cancel))
        return future

    def release(self, cancel):
        with self.lock:
            self.pending.discard(cancel)

    def generate(self, text, cancel):
        chunks, rate, samples = [], None, 0
        generator = None
        deadline = time.monotonic() + 180
        try:
            with self.lock:
                self.active = True
            if cancel.is_set() or self.stopping.is_set():
                raise VoiceError("cancelled", 499)
            generator = self.model.generate(text=text, **self.conditioning(), lang_code="english", stream=True, streaming_interval=0.5, max_tokens=1500, verbose=False)
            for chunk in generator:
                if cancel.is_set() or self.stopping.is_set():
                    raise VoiceError("cancelled", 499)
                if time.monotonic() > deadline:
                    raise VoiceError("generation_timeout", 504)
                next_rate = chunk.sample_rate
                if type(next_rate) is not int or not 8000 <= next_rate <= 96000 or (rate is not None and next_rate != rate):
                    raise VoiceError("invalid_audio")
                rate = next_rate
                values = chunk.audio.reshape(-1).tolist() if hasattr(chunk.audio, "reshape") else chunk.audio
                if not isinstance(values, (list, tuple)) or samples + len(values) > rate * 120:
                    raise VoiceError("audio_limit")
                pcm = array("h")
                for value in values:
                    if not isinstance(value, (int, float)) or not math.isfinite(value):
                        raise VoiceError("invalid_audio")
                    pcm.append(round(max(-1, min(1, value)) * 32767))
                if sys.byteorder != "little":
                    pcm.byteswap()
                chunks.append(pcm.tobytes())
                samples += len(values)
            if not samples:
                raise VoiceError("empty_audio")
            if cancel.is_set() or self.stopping.is_set():
                raise VoiceError("cancelled", 499)
            output = io.BytesIO()
            with wave.open(output, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(rate)
                wav.writeframes(b"".join(chunks))
            return output.getvalue()
        except VoiceError:
            raise
        except Exception:
            raise VoiceError("synthesis_failed") from None
        finally:
            cleanup_failed = False
            try:
                if generator is not None and hasattr(generator, "close"):
                    generator.close()
                decoder = getattr(getattr(self.model, "speech_tokenizer", None), "decoder", None)
                if hasattr(decoder, "reset_streaming_state"):
                    decoder.reset_streaming_state()
            except Exception:
                self.ready = False
                self.error = "decoder_reset_failed"
                cleanup_failed = True
            with self.lock:
                self.active = False
            if cleanup_failed:
                raise VoiceError("synthesis_failed") from None

    def close(self):
        self.stopping.set()
        with self.lock:
            for cancel in self.pending:
                cancel.set()
        self.executor.shutdown(wait=True, cancel_futures=True)


def create_server(config, port=4181, loader=load_model):
    runtime = VoiceRuntime(config, loader)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, status, value, audio=False):
            data = value if audio else json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "audio/wav" if audio else "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def trusted(self):
            try:
                hosts = self.headers.get_all("Host", [])
                address = urlsplit("http://" + hosts[0]) if len(hosts) == 1 else None
                return bool(address and address.hostname in ("127.0.0.1", "localhost") and address.port == self.server.server_port and not (address.username or address.password or address.path or address.query or address.fragment) and ipaddress.ip_address(self.client_address[0]).is_loopback and "Origin" not in self.headers and self.headers.get("Sec-Fetch-Site") != "cross-site")
            except ValueError:
                return False

        def do_GET(self):
            if not self.trusted():
                return self.reply(403, {"error": "local_requests_only"})
            if self.path != "/health":
                return self.reply(404, {"error": "not_found"})
            state = runtime.state()
            self.reply(200 if state["ready"] else 503, state)

        def do_POST(self):
            cancel, future = threading.Event(), None
            try:
                self.connection.settimeout(5)
                if not self.trusted():
                    raise VoiceError("local_requests_only", 403)
                if self.path != "/v1/audio/speech":
                    raise VoiceError("not_found", 404)
                if self.headers.get_content_type() != "application/json":
                    raise VoiceError("json_required", 415)
                lengths = self.headers.get_all("Content-Length", [])
                if len(lengths) != 1 or "Transfer-Encoding" in self.headers:
                    raise VoiceError("length_required", 411)
                size = int(lengths[0])
                if not 0 < size <= 8192:
                    raise VoiceError("request_too_large", 413)
                body = self.rfile.read(size)
                data = json.loads(body)
                if not isinstance(data, dict) or set(data) - {"input", "model", "voice", "response_format"}:
                    raise VoiceError("invalid_request", 400)
                text = data.get("input")
                if not isinstance(text, str) or not text.strip() or len(text) > 1000:
                    raise VoiceError("invalid_input", 400)
                if data.get("model", config.model) != config.model or data.get("voice", config.voice) != config.voice or data.get("response_format", "wav") != "wav":
                    raise VoiceError("unsupported_voice_or_format", 400)
                future = runtime.submit(text.strip(), cancel)
                deadline = time.monotonic() + 180
                while not future.done():
                    if time.monotonic() > deadline:
                        raise VoiceError("generation_timeout", 504)
                    if select.select([self.connection], [], [], 0.05)[0] and not self.connection.recv(1, socket.MSG_PEEK):
                        cancel.set()
                        return
                self.reply(200, future.result(), audio=True)
            except VoiceError as error:
                self.reply(error.status, {"error": str(error)})
            except (ValueError, UnicodeError):
                self.reply(400, {"error": "invalid_request"})
            except (OSError, RuntimeError):
                self.reply(503, {"error": "voice_unavailable"})
            finally:
                cancel.set()
                if future is not None:
                    future.cancel()

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.runtime = runtime
    runtime.executor.submit(runtime.prepare)
    return server


def main():
    parser = argparse.ArgumentParser(description="Local Qwen3 voice service")
    parser.add_argument("--config", default=".kitt-state/local-voice.json")
    parser.add_argument("--port", type=int, default=4181)
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.exit(2, "Qwen3 inference requires an Apple Silicon Mac. Offline tests work on other platforms.\n")
    try:
        config = VoiceConfig.read(args.config)
        server = create_server(config, args.port)
    except (VoiceError, OSError, ValueError):
        parser.exit(2, "Local voice configuration or port is unavailable.\n")
    print("Local voice service is starting on loopback. Check /health for readiness.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        server.runtime.close()


if __name__ == "__main__":
    main()
