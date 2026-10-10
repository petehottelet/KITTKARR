#!/usr/bin/env python3
# Revision 4. Validate the calibrated KITT and computer wake-word configuration.
import hashlib
import subprocess
import tarfile
import urllib.request
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / '.kitt-state'
MODELS = STATE / 'wake-models'
MODEL = 'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20'


def download(url, destination, expected):
    if not destination.exists() or hashlib.sha256(destination.read_bytes()).hexdigest() != expected:
        temporary = destination.with_suffix('.download')
        with urllib.request.urlopen(url, timeout=60) as response, temporary.open('wb') as output:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != expected:
            temporary.unlink()
            raise RuntimeError('Downloaded model checksum did not match.')
        temporary.replace(destination)


def main():
    MODELS.mkdir(parents=True, exist_ok=True, mode=0o700)
    environment = STATE / 'wake-venv'
    if not (environment / 'bin/python').exists():
        venv.create(environment, with_pip=True)
    subprocess.run([str(environment / 'bin/python'), '-m', 'pip', 'install', '--disable-pip-version-check',
                    'sherpa-onnx==1.13.8', 'numpy==2.0.2'], check=True)
    archive = MODELS / 'phonetic.tar.bz2'
    download('https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/' + MODEL + '.tar.bz2', archive,
             '68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6')
    with tarfile.open(archive) as package:
        for member in package.getmembers():
            target = (MODELS / member.name).resolve()
            if MODELS.resolve() not in target.parents or member.issym() or member.islnk():
                raise RuntimeError('Unsafe model archive entry.')
        package.extractall(MODELS)
    download('https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx', MODELS / 'silero_vad.onnx',
             '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6')
    subprocess.run([str(environment / 'bin/python'), str(ROOT / 'assistant/wake-worker-v1.py'),
                    '--models', str(MODELS), '--keywords', str(ROOT / 'assistant/wake-keywords-v4.txt')],
                   input=b'', check=True)
    print('Local KITT and computer wake words are installed.')


if __name__ == '__main__':
    main()
