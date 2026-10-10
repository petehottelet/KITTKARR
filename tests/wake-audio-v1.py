#!/usr/bin/env python3
# Revision 5. Acoustic wake candidates plus host word-boundary rejection for toolkit.
import json
import subprocess
import tempfile
from array import array
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CASES = [
    ('kitt', 'Kit, tell me the time.', 'kitt'),
    ('hey-kitt', 'Hey Kit. What should I do today?', 'kitt'),
    ('computer', 'Computer, tell me the time.', 'computer'),
    ('hey-computer', 'Hey Computer, what is the weather in Redwood City?', 'computer'),
    ('prior-speech', 'I was just talking about the weather and other things, Computer, tell me the time.', 'computer'),
    ('ordinary', 'Good morning. Please check my calendar.', None),
    ('similar', 'The kitchen is clean. The cat is sleeping.', None),
    # The short KITT sound occurs inside toolkit. This may produce a local
    # candidate, but the host must reject its full-word transcript before asking.
    ('inside-words', 'Please get the tickets. I need a toolkit. Can you keep it quiet?', 'candidate-only'),
]

with tempfile.TemporaryDirectory(prefix='kitt-wake-test-') as temporary:
    for label, text, expected in CASES:
        file = Path(temporary) / label
        subprocess.run(['/usr/bin/say', '-v', 'Samantha', '-r', '160', '-o', str(file) + '.aiff', text], check=True)
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(file) + '.aiff', '-af', 'apad=pad_dur=3',
                        '-ar', '16000', '-ac', '1', '-f', 's16le', str(file) + '.pcm'], check=True)
        raw = Path(str(file) + '.pcm').read_bytes()
        for gain in ([1, .02] if expected in ('kitt', 'computer') else [1]):
            audio = bytes(32000) + array('h', (int(sample * gain) for sample in array('h', raw))).tobytes()
            result = subprocess.run([str(ROOT / '.kitt-state/wake-venv/bin/python'), str(ROOT / 'assistant/wake-worker-v1.py'),
                                     '--models', str(ROOT / '.kitt-state/wake-models'), '--keywords', str(ROOT / 'assistant/wake-keywords-v4.txt'), '--gain', '32'],
                                    input=audio, capture_output=True, check=True, timeout=15)
            events = [json.loads(line) for line in result.stdout.splitlines()]
            wakes = [e['keyword'] for e in events if e['event'] == 'wake']
            commands = [e for e in events if e['event'] == 'command']
            if expected == 'candidate-only':
                assert wakes in ([], ['kitt']), (label, gain, wakes)
                check = subprocess.run(['node', '--input-type=module', '-e',
                    "import {wakeCommand} from './assistant/wake-listener-v1.mjs'; if(wakeCommand(process.argv[1])!==null)process.exit(1)", text], cwd=ROOT)
                assert check.returncode == 0, 'A partial word must not dispatch a request'
                print(f'{label}: local candidate {wakes}, host rejected partial-word transcript', flush=True)
                continue
            assert wakes == ([expected] if expected else []), (label, gain, wakes)
            assert len(commands) == (1 if expected else 0), (label, gain, 'command capture did not finish')
            print(f'{label}, input gain {gain}: passed', flush=True)
