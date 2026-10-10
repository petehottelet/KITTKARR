# Revision 4. Run complete upstream styles with live masks for every scene mode.
import io
import json
import os
import signal
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np
from PIL import Image
from yautja import __version__
from yautja.render import Renderer
from yautja.semantic import Subject

WIDTH, HEIGHT, FPS = 640, 384, 12
latest = None
latest_id = 0
stopping = threading.Event()
lock = threading.Lock()
capture_errors = []
presets = {p['id']: p for p in json.loads(Path(__file__).with_name('yautja-presets-v1.json').read_text())['presets']}
requested_preset = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] in presets else 'yautja'
segmented = None
segmentation_error = None
segmenter = None

def read_controls():
    global requested_preset
    for line in sys.stdin:
        try:
            preset = json.loads(line).get('preset')
            if preset in presets:
                with lock:
                    requested_preset = preset
        except (ValueError, TypeError, AttributeError):
            continue

def status(**values):
    print(json.dumps(values), file=sys.stderr, flush=True)

def stop(*_):
    stopping.set()

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
status(event="starting", version=__version__, style="Yautja low detail", camera="Mac default camera")
# No audio input, output files, remote services or retained frames.
capture = subprocess.Popen([
    os.environ.get("KITT_FFMPEG", "ffmpeg"), "-hide_banner", "-loglevel", "warning",
    "-f", "avfoundation", "-framerate", "30", "-i", "default:none", "-an",
    "-vf", f"fps={FPS},scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,crop={WIDTH}:{HEIGHT}",
    "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

def read_camera():
    global latest, latest_id
    size = WIDTH * HEIGHT * 3
    while not stopping.is_set():
        data = capture.stdout.read(size)
        if len(data) != size:
            break
        with lock:
            latest = data
            latest_id += 1

def read_errors():
    for line in capture.stderr:
        capture_errors.append(line.decode("utf8", errors="replace").strip())
        del capture_errors[:-8]

def segment_camera():
    global segmenter, segmented, segmentation_error
    last_number = 0
    try:
        segmenter = subprocess.Popen([str(Path(__file__).resolve().parent.parent / '.kitt-state/yautja-segmenter-v1')],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        while not stopping.is_set():
            with lock:
                data, number = latest, latest_id
            if data is None or number == last_number:
                stopping.wait(.015)
                continue
            started = time.monotonic()
            source = Image.frombytes('RGB', (WIDTH, HEIGHT), data).resize((320, 192), Image.Resampling.BILINEAR)
            segmenter.stdin.write(source.tobytes())
            segmenter.stdin.flush()
            header = segmenter.stdout.read(8)
            if len(header) != 8:
                raise RuntimeError('Local person segmentation stopped. Retry the camera.')
            w, h = struct.unpack('>II', header)
            if not 1 <= w * h <= WIDTH * HEIGHT * 4:
                raise RuntimeError('Local person mask could not be read.')
            mask_bytes = segmenter.stdout.read(w * h)
            if len(mask_bytes) != w * h:
                raise RuntimeError('Local person mask was interrupted.')
            mask = Image.frombytes('L', (w, h), mask_bytes).resize((WIDTH, HEIGHT), Image.Resampling.BILINEAR)
            mask = np.asarray(mask, dtype=np.float32) / 255
            with lock:
                segmented = (data, number, mask, time.monotonic())
            if last_number == 0 or number % 12 == 0:
                status(event='segmentation', maskMs=round((time.monotonic()-started)*1000, 1), personPixels=int((mask > .5).sum()))
            last_number = number
    except Exception as error:
        with lock:
            segmentation_error = str(error)

threading.Thread(target=read_camera, daemon=True).start()
threading.Thread(target=read_errors, daemon=True).start()
threading.Thread(target=read_controls, daemon=True).start()
threading.Thread(target=segment_camera, daemon=True).start()
try:
    renderer, active_preset = None, None
    start = time.monotonic()
    last_frame, rendered = 0, 0
    while not stopping.is_set():
        with lock:
            preset = requested_preset
            if segmentation_error:
                raise RuntimeError(segmentation_error)
            if segmented is not None and time.monotonic() - segmented[3] < 1:
                data, number, mask, _ = segmented
            else:
                data, number, mask = None, 0, None
        if data is None or number == last_frame:
            if capture.poll() is not None:
                raise RuntimeError("Camera unavailable. Allow Camera access for KITT in macOS System Settings, then retry.")
            if time.monotonic() - start > 25 and rendered == 0:
                raise RuntimeError("Waiting for camera permission. Allow KITT to use the camera, then retry.")
            stopping.wait(.01)
            continue
        last_frame = number
        changed = active_preset != preset
        if changed:
            # Load the complete upstream recipe, including scene processing,
            # subject effects, targeting, HUD, and animation. Only Yautja keeps
            # Driver's explicitly requested low-detail/red-HUD customization.
            renderer = Renderer(WIDTH, HEIGHT, **presets[preset]['options'])
            active_preset = preset
            style_start = time.monotonic()
        source = Image.frombytes("RGB", (WIDTH, HEIGHT), data)
        subjects = [Subject(mask=mask, label='person', score=1., track_id=1)] if mask is not None and (mask > .5).any() else []
        result = renderer.render(source, time.monotonic() - style_start, subjects=subjects)
        output = io.BytesIO()
        result.save(output, format="JPEG", quality=82)
        jpeg = output.getvalue()
        sys.stdout.buffer.write(struct.pack(">I", len(jpeg)) + jpeg)
        sys.stdout.buffer.flush()
        if changed:
            status(event="preset", preset=active_preset)
        rendered += 1
        if rendered == 1:
            status(event="ready", width=WIDTH, height=HEIGHT, version=__version__)
except BrokenPipeError:
    pass
except Exception as error:
    status(event="error", error=str(error))
finally:
    stopping.set()
    for process in (capture, segmenter):
        if process is None:
            continue
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
