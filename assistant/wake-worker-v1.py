#!/usr/bin/env python3
# Revision 12. Measure foreground loudness from the current wake word, excluding older room speech.
import argparse
import base64
import json
import signal
import sys
from collections import deque
from pathlib import Path

import numpy as np
import sherpa_onnx

RATE = 16000
FRAME = 512
finish_requested = False


def finish_signal(_signal, _frame):
    global finish_requested
    finish_requested = True


def emit(event, **fields):
    print(json.dumps(dict(event=event, **fields)), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', required=True)
    parser.add_argument('--keywords', required=True)
    parser.add_argument('--gain', type=float, default=24)
    parser.add_argument('--local-fallback', action='store_true')
    args = parser.parse_args()
    if not .1 <= args.gain <= 64:
        parser.error('Microphone gain must be between 0.1 and 64.')
    model = Path(args.models) / 'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20'
    suffix = 'epoch-13-avg-2-chunk-8-left-64'
    spotter = sherpa_onnx.KeywordSpotter(
        tokens=str(model / 'tokens.txt'), encoder=str(model / ('encoder-' + suffix + '.int8.onnx')),
        decoder=str(model / ('decoder-' + suffix + '.onnx')), joiner=str(model / ('joiner-' + suffix + '.int8.onnx')),
        keywords_file=args.keywords, num_threads=1, num_trailing_blanks=1,
    )
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = str(Path(args.models) / 'silero_vad.onnx')
    config.silero_vad.min_silence_duration = 0.2
    config.silero_vad.min_speech_duration = 0.1
    config.silero_vad.max_speech_duration = 35
    config.sample_rate = RATE
    config.num_threads = 1
    vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=40)
    stream = spotter.create_stream()
    ring = bytearray()
    command = bytearray()
    total = 0
    keyword = None
    detected_at = last_voice = last_level = 0
    stream_base = utterance_start = 0
    last_speech = -10
    peak_hold = 0
    was_speaking = False
    fallback = None
    fallback_voice = 0
    reset_at = 0
    recent_energy = deque(maxlen=64)
    foreground_reference = 0
    fallback_last_voice = 0
    fallback_reference = 0
    smoothed_energy = 0
    signal.signal(signal.SIGUSR1, finish_signal)
    emit('ready')
    while True:
        raw = sys.stdin.buffer.read(FRAME * 2)
        if not raw:
            break
        samples = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768
        raw_energy = float(np.sqrt(np.mean(samples * samples)))
        smoothed_energy = smoothed_energy * .55 + raw_energy * .45
        frame_peak = float(np.max(np.abs(samples)))
        # Soft-attack peak hold so Bluetooth spikes (AirPods) do not crush gain.
        if frame_peak > peak_hold:
            peak_hold = peak_hold * .7 + frame_peak * .3
        else:
            peak_hold = max(frame_peak, peak_hold * .98)
        # Limit against this frame as well as the held peak. Fixed high gain
        # clipped ordinary speech and made an otherwise valid wake word vanish.
        applied = min(args.gain, .8 / max(frame_peak, peak_hold, .000001))
        samples *= applied
        np.clip(samples, -1.0, 1.0, out=samples)
        total += len(samples)
        now = total / RATE
        startup_meter = FRAME * 8 <= total <= RATE and total % (FRAME * 4) == 0
        if startup_meter or int(now) > int(now - len(samples) / RATE):
            emit('meter', seconds=round(now, 2), rms=round(float(np.sqrt(np.mean(samples * samples))), 5), gain=round(applied, 2))
        if now - last_level >= .09:
            emit('level', value=float(np.sqrt(np.mean(samples * samples))))
            last_level = now
        vad.accept_waveform(samples)
        speaking = vad.is_speech_detected()
        if speaking and not was_speaking:
            utterance_start = now - .15
        if speaking:
            last_speech = now
        was_speaking = speaking
        if speaking:
            recent_energy.append((now, smoothed_energy))
        while not vad.empty():
            vad.pop()
        if keyword is None:
            ring.extend(raw)
            del ring[:-RATE * 2 * 2]
            # Bound stale decoder state during long quiet stretches. Preserve the
            # audio ring and VAD so the next spoken word keeps its leading edge.
            if now - last_speech > 2 and now - reset_at > 8:
                stream = spotter.create_stream()
                stream_base = reset_at = now
            if args.local_fallback:
                if speaking and fallback is None:
                    fallback = bytearray(ring)
                    fallback_voice = 0
                    fallback_reference = smoothed_energy
                    fallback_last_voice = now
                elif fallback is not None:
                    fallback.extend(raw)
                if fallback is not None:
                    if speaking:
                        fallback_voice += len(samples) / RATE
                        fallback_reference = max(fallback_reference, smoothed_energy)
                        if smoothed_energy >= fallback_reference * .18:
                            fallback_last_voice = now
                    if now - fallback_last_voice >= .8 or len(fallback) >= RATE * 2 * 22:
                        if fallback_voice >= .2:
                            request = np.frombuffer(fallback, dtype='<i2').astype(np.float32)
                            request *= min(args.gain, 26214 / max(float(np.max(np.abs(request))), 1))
                            emit('utterance', pcm=base64.b64encode(request.astype('<i2').tobytes()).decode('ascii'))
                        fallback = None
            stream.accept_waveform(RATE, samples)
            while spotter.is_ready(stream):
                spotter.decode_stream(stream)
                result = spotter.get_result(stream)
                if result in ('KITT', 'COMPUTER'):
                    times = spotter.timestamps(stream)
                    word_start = stream_base + times[0] if times else now - .5
                    accepted = now - last_speech <= 1.2
                    emit('candidate', keyword=result.lower(), recentSpeech=round(now-last_speech, 3), utteranceOffset=round(word_start-utterance_start, 3), accepted=accepted, reason='recent-speech' if accepted else 'no-recent-speech')
                    # VAD can join background speech/noise to the request.
                    # Its utterance start is not a reliable wake-word boundary.
                    # The host also checks the completed transcript for a real
                    # standalone wake word before dispatching an agent request.
                    if not accepted:
                        stream = spotter.create_stream()
                        stream_base = now
                        break
                    keyword = result
                    # Keyword timestamps can lag or drift relative to the PCM ring.
                    # Keep its full bounded two seconds for reliable transcript validation.
                    command.extend(ring)
                    detected_at = last_voice = now
                    word_energy = [energy for at, energy in recent_energy if at >= max(word_start, now-1.2)]
                    foreground_reference = float(np.percentile(word_energy, 80)) if word_energy else smoothed_energy
                    emit('wake', keyword=keyword.lower(), detectedSeconds=round(now, 3))
                    break
        else:
            command.extend(raw)
            # Compare unamplified energy: automatic gain otherwise makes distant
            # TV speech as loud as a nearby request to the end-of-turn detector.
            foreground = speaking and smoothed_energy >= foreground_reference * .18
            if foreground:
                last_voice = now
                foreground_reference = max(foreground_reference, smoothed_energy)
            if finish_requested or (now - detected_at >= 1.2 and now - last_voice >= .8) or now - detected_at >= 30:
                request = np.frombuffer(command, dtype='<i2').astype(np.float32)
                request *= min(args.gain, 26214 / max(float(np.max(np.abs(request))), 1))
                emit('endpoint', reason='button' if finish_requested else 'limit' if now-detected_at >= 30 else 'foreground-pause', recordingSeconds=round(now-detected_at, 3), trailingSeconds=round(now-last_voice, 3), vadSpeaking=bool(speaking), foreground=bool(foreground))
                emit('command', keyword=keyword.lower(), pcm=base64.b64encode(request.astype('<i2').tobytes()).decode('ascii'))
                return
    # EOF while waiting or during a command discards the buffer; only a completed
    # request is allowed to leave this worker.


if __name__ == '__main__':
    main()
