import http.client
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
import wave

spec = importlib.util.spec_from_file_location("local_voice", Path(__file__).resolve().parents[1] / "assistant/local-tts-v1.py")
voice = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = voice
spec.loader.exec_module(voice)


class Model:
    def __init__(self):
        self.config = SimpleNamespace(tts_model_type="custom_voice")
        self.reset_count = 0
        self.speech_tokenizer = SimpleNamespace(decoder=SimpleNamespace(reset_streaming_state=self.reset))
        self.calls = []

    def reset(self):
        self.reset_count += 1

    def generate(self, **options):
        self.calls.append(options)
        yield SimpleNamespace(audio=[0.1, -0.2] * 160, sample_rate=16000)


class RuntimeTests(unittest.TestCase):
    def runtime(self, model=None):
        model = model or Model()
        runtime = voice.VoiceRuntime(voice.VoiceConfig("example-model"), lambda _: model)
        runtime.executor.submit(runtime.prepare).result(timeout=2)
        self.addCleanup(runtime.close)
        return runtime, model

    def test_valid_wav_and_no_reference_sent_to_custom_voice(self):
        runtime, model = self.runtime()
        result = runtime.submit("Example speech", threading.Event()).result(timeout=2)
        with wave.open(io.BytesIO(result)) as wav:
            self.assertEqual((wav.getframerate(), wav.getnchannels(), wav.getsampwidth()), (16000, 1, 2))
            self.assertEqual(wav.getnframes(), 320)
        self.assertEqual(model.calls[0]["voice"], "ryan")
        self.assertNotIn("ref_audio", model.calls[0])
        self.assertEqual(model.reset_count, 1)

    def test_invalid_audio_is_redacted_and_decoder_is_reset(self):
        model = Model()
        model.generate = lambda **_: iter([SimpleNamespace(audio=[float("nan")], sample_rate=16000)])
        runtime, _ = self.runtime(model)
        with self.assertRaisesRegex(voice.VoiceError, "invalid_audio"):
            runtime.submit("Example", threading.Event()).result(timeout=2)
        self.assertEqual(model.reset_count, 1)

    def test_failure_never_exposes_model_diagnostics(self):
        model = Model()

        def fail(**_):
            raise RuntimeError("EXAMPLE_PRIVATE_DIAGNOSTIC")

        model.generate = fail
        runtime, _ = self.runtime(model)
        with self.assertRaisesRegex(voice.VoiceError, "^synthesis_failed$"):
            runtime.submit("Example", threading.Event()).result(timeout=2)

    def test_cancelled_queued_work_never_runs(self):
        runtime, model = self.runtime()
        cancel = threading.Event()
        cancel.set()
        with self.assertRaisesRegex(voice.VoiceError, "cancelled"):
            runtime.submit("Example", cancel).result(timeout=2)
        self.assertEqual(model.calls, [])

    def test_queue_is_bounded_and_cancellation_recovers(self):
        model = Model()
        entered, release = threading.Event(), threading.Event()

        def generate(**_):
            entered.set()
            release.wait(2)
            yield SimpleNamespace(audio=[0.1], sample_rate=16000)

        model.generate = generate
        runtime, _ = self.runtime(model)
        cancellations = [threading.Event() for _ in range(3)]
        jobs = [runtime.submit("Example", cancel) for cancel in cancellations]
        self.assertTrue(entered.wait(2))
        with self.assertRaisesRegex(voice.VoiceError, "busy"):
            runtime.submit("Overflow", threading.Event())
        for cancel in cancellations:
            cancel.set()
        release.set()
        for job in jobs:
            with self.assertRaises(voice.VoiceError):
                job.result(timeout=2)
        self.assertEqual(runtime.state()["queued"], 0)

    def test_base_model_requires_a_reference(self):
        model = Model()
        model.config.tts_model_type = "base"
        runtime, _ = self.runtime(model)
        self.assertFalse(runtime.state()["ready"])
        self.assertEqual(runtime.state()["error"], "model_unavailable")

    def test_decoder_cleanup_failure_disables_further_generation(self):
        model = Model()

        def fail():
            raise RuntimeError("EXAMPLE_PRIVATE_DIAGNOSTIC")

        model.speech_tokenizer.decoder.reset_streaming_state = fail
        runtime, _ = self.runtime(model)
        with self.assertRaisesRegex(voice.VoiceError, "^synthesis_failed$"):
            runtime.submit("Example", threading.Event()).result(timeout=2)
        self.assertFalse(runtime.state()["ready"])
        with self.assertRaisesRegex(voice.VoiceError, "not_ready"):
            runtime.submit("Example", threading.Event())

    def test_config_requires_local_files(self):
        with tempfile.TemporaryDirectory() as directory:
            config_file = Path(directory) / "config.json"
            config_file.write_text(json.dumps({"model_path": directory}))
            self.assertEqual(voice.VoiceConfig.read(config_file).voice, "local")
            for patch in [{"model_path": "https://example.com/model"}, {"model_path": directory, "reference_audio": "missing.wav"}, {"model_path": directory, "unknown": True}]:
                config_file.write_text(json.dumps(patch))
                with self.assertRaisesRegex(voice.VoiceError, "invalid_configuration"):
                    voice.VoiceConfig.read(config_file)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.model = Model()
        self.server = voice.create_server(voice.VoiceConfig("example-model"), 0, lambda _: self.model)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        deadline = time.monotonic() + 2
        while not self.server.runtime.ready and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(self.server.runtime.ready)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.server.runtime.close()
        self.thread.join(timeout=2)

    def request(self, route="/v1/audio/speech", data=None, headers=None):
        client = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            client.request("GET" if data is None else "POST", route, body=None if data is None else json.dumps(data), headers={"Content-Type": "application/json", **(headers or {})})
            result = client.getresponse()
            return result.status, result.read()
        finally:
            client.close()

    def test_loopback_health_and_wav_contract(self):
        self.assertEqual(self.request("/health")[0], 200)
        status, wav = self.request(data={"input": "Example", "model": "qwen-local", "voice": "local", "response_format": "wav"})
        self.assertEqual(status, 200)
        self.assertEqual(wav[:4], b"RIFF")
        self.assertNotIn(b"model_path", self.request("/health")[1])

    def test_browser_and_rebinding_requests_are_rejected(self):
        for headers in [{"Origin": "http://localhost"}, {"Host": "example.com"}, {"Sec-Fetch-Site": "cross-site"}]:
            self.assertEqual(self.request(data={"input": "Example"}, headers=headers)[0], 403)
        self.assertEqual(self.model.calls, [])

    def test_request_bounds_and_voice_validation(self):
        for data in [{"input": ""}, {"input": "x" * 1001}, {"input": "Example", "response_format": "mp3"}, {"input": "Example", "voice": "unknown"}, {"input": "Example", "path": "ignored"}]:
            self.assertEqual(self.request(data=data)[0], 400)
        self.assertEqual(self.request(data={"input": "x" * 9000})[0], 413)
        self.assertEqual(self.request("/missing")[0], 404)
        self.assertEqual(self.model.calls, [])


if __name__ == "__main__":
    unittest.main()
