# Revision 1. Acoustic regression: finish foreground requests while quieter background speech continues.
import subprocess
import tempfile
import json
import base64
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
rows = []
with tempfile.TemporaryDirectory(prefix="kitt-endpoint-") as tmp:
    d = Path(tmp)

    def speech(name, text):
        subprocess.run(
            [
                "/usr/bin/say",
                "-v",
                "Samantha",
                "-r",
                "180",
                "-o",
                str(d / name) + ".aiff",
                text,
            ],
            check=True,
        )
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(d / name) + ".aiff",
                "-ar",
                "16000",
                "-ac",
                "1",
                "-f",
                "s16le",
                str(d / name) + ".pcm",
            ],
            check=True,
        )
        a = (
            np.frombuffer((d / (name + ".pcm")).read_bytes(), dtype="<i2").astype(float)
            / 32768
        )
        assert max(abs(a)) > 0.01, "Silent fixture"
        return a

    bg = speech(
        "background",
        "The program continues with a conversation about the latest designs and how we can make more things happen over the next several weeks. There are also several reports to consider while the conversation continues.",
    )
    bg *= 0.003 / np.sqrt(np.mean(bg * bg))
    for label, text in [
        ("short", "Computer, what time is it?"),
        (
            "long",
            "Computer, check my calendar tomorrow, and tell me whether I have any meetings after three in the afternoon.",
        ),
    ]:
        primary = speech(label, text)
        primary *= 0.04 / np.sqrt(np.mean(primary * primary))
        onset = 16000
        mixed = np.resize(bg, onset + len(primary) + 16000 * 18)
        mixed[onset : onset + len(primary)] += primary
        raw = (np.clip(mixed, -0.99, 0.99) * 32767).astype("<i2").tobytes()
        for version, worker in [("new", ROOT / "assistant/wake-worker-v1.py")]:
            p = subprocess.run(
                [
                    str(ROOT / ".kitt-state/wake-venv/bin/python"),
                    str(worker),
                    "--models",
                    str(ROOT / ".kitt-state/wake-models"),
                    "--keywords",
                    str(ROOT / "assistant/wake-keywords-v4.txt"),
                    "--gain",
                    "12",
                ],
                input=raw,
                capture_output=True,
                check=True,
                timeout=25,
            )
            events = [json.loads(line) for line in p.stdout.splitlines()]
            command = next((e for e in events if e["event"] == "command"), None)
            wake = next((e for e in events if e["event"] == "wake"), None)
            endpoint = next((e for e in events if e["event"] == "endpoint"), None)
            result = {
                "case": label,
                "version": version,
                "primarySeconds": len(primary) / 16000,
                "wake": wake,
                "endpoint": endpoint,
                "commandSeconds": len(base64.b64decode(command["pcm"])) / 32000
                if command
                else None,
            }
            assert command and endpoint, (label, "No completed foreground request")
            assert endpoint["reason"] == "foreground-pause", endpoint
            assert endpoint["recordingSeconds"] >= len(primary) / 16000 - 0.5, (
                "Request was cut short"
            )
            assert endpoint["recordingSeconds"] <= len(primary) / 16000 + 1.5, (
                "Background conversation held the request open"
            )
            assert endpoint["vadSpeaking"], (
                "Fixture did not exercise continuing background speech"
            )
            print(
                f"{label}: completed after {endpoint['trailingSeconds']} seconds of foreground pause",
                flush=True,
            )
