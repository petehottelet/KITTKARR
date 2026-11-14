# Voice providers

Speech synthesis, speech recognition, and conversation are three separate settings. No paid voice provider is enabled by default.

## Mac system voice (default)

Set `TTS_PROVIDER=system` or leave voice settings unset. The assistant uses macOS `say` and plays through the Mac's selected output. Set `KITT_MAC_VOICE` to a voice listed by `say -v '?'` if desired. FFmpeg produces the waveform that drives the LEDs. No speech-generation account is required.

## OpenAI-compatible speech service

Add these settings to your private `.env`, then restart:

```dotenv
TTS_PROVIDER=openai-compatible
TTS_ENDPOINT=http://127.0.0.1:8880/v1/audio/speech
TTS_MODEL=kokoro
TTS_VOICE=af_heart
TTS_API_KEY=
```

This is an example for a separately installed [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) server. Follow that project's installation instructions and select a voice it actually provides. KITTKARR does not install models or start the speech server. Remote services use their own HTTPS endpoint, model, voice, and optional bearer key. Requests contain `input`, optional `model` and `voice`, and `response_format: "mp3"`.

## Local Qwen3 voice engine

KITTKARR includes an optional Qwen3 service for an Apple Silicon Mac, using [MLX-Audio](https://pypi.org/project/mlx-audio/0.6.5/). It runs separately from the assistant, accepts only local requests, and produces WAV audio. Python 3.10+ is required. Install the optional dependencies in a dedicated environment:

```sh
python3 -m venv .venv-local-voice
source .venv-local-voice/bin/activate
python -m pip install -r requirements-local-voice.txt
```

Download a compatible MLX Qwen3 **CustomVoice** or **Base** model separately into ignored `.kitt-state/models/`. The service loads only an existing local directory and enables offline model loading; it does not download models or send reference audio to a cloud service. [Upstream Qwen3 documentation](https://github.com/Blaizzy/mlx-audio/blob/main/mlx_audio/tts/models/qwen3_tts/README.md) describes the model variants. CustomVoice uses a supported speaker; Base requires your reference recording and its exact transcript.

For a CustomVoice model downloaded into `.kitt-state/models/qwen3`, create the private configuration and start the service:

```sh
npm run voice:setup -- --model-dir .kitt-state/models/qwen3 --speaker ryan
npm run voice:local
```

For a Base model, add `--reference-audio .kitt-state/reference.wav --reference-text-file .kitt-state/reference.txt` to the setup command. Configuration is saved in ignored `.kitt-state/local-voice.json`; existing configuration is preserved. Models, reference files, and transcripts are user-supplied and must stay private. If the host and voice service use different Python environments, set `KITT_LOCAL_TTS_PYTHON` privately to the voice environment's Python executable.

Check `http://127.0.0.1:4181/health` for `ready: true`, then set `TTS_PROVIDER=local` in the private `.env` and restart the assistant. Clear old `TTS_ENDPOINT`, `TTS_MODEL`, and `TTS_VOICE` overrides to use the defaults: loopback port 4181, model alias `qwen-local`, and voice alias `local`. A custom `--port` needs a matching loopback `TTS_ENDPOINT`. Local mode never forwards `TTS_API_KEY` or falls back to a cloud voice. The service permits one active generation and two waiting requests, cancels disconnected requests at the next generation checkpoint, and bounds input, audio duration, and request time.

## Voice effects

Open **Details → Settings → Voice effects**. Enable effects, select a filter and room, adjust the mix and output gain, then choose **Apply effects**. Robot filtering offers several modulation styles. **Test voice** plays through the saved settings. Applying a change stops the current reply. Disabling effects restores unprocessed speech.

Settings persist independently for each configured provider, endpoint, model, and voice, with Mac system voices also distinguished. The local state file stores hashed profile keys and effect settings. Effects apply to system speech, HTTP/local speech, and cached acknowledgments. The LED waveform is measured after processing, including any room tail. Voice selection remains configured on the host.

## Earlier spoken replies

Compatible chat services stream answer text into short phrases, allowing playback to begin before the complete answer arrives. Speech synthesis prepares at most one phrase ahead of playback. The Responses adapter streams explicitly marked final-answer messages; commentary and tool-planning messages remain silent. Providers that return only a completed answer keep the existing behavior. The Codex and Grok Bot adapters still wait for the complete answer.

Links and citation markup are held until complete, then cleaned for speech. Display links remain available. Interrupted streams stop playback, discard queued phrases, and do not automatically replay text already emitted. Set `KITT_STREAM_REPLIES=0` to request complete answers before speaking, including for chat endpoints without streaming support. See the [Responses streaming event reference](https://developers.openai.com/api/reference/resources/responses/streaming-events#response.output_text.delta).

`npm test` includes fake-model local voice tests; they require Python but no model downloads, Mac audio hardware, cloud credentials, or provider calls. Actual synthesis quality and performance should be checked on the target Mac.

## Other HTTP services, including Voicebox

```dotenv
TTS_PROVIDER=http
TTS_ENDPOINT=http://127.0.0.1:9000/speech
TTS_VOICE=YOUR_VOICE
TTS_MODEL=YOUR_MODEL
TTS_API_KEY=
TTS_OPTIONS='{"speed":1.0}'
```

The generic contract is `POST` JSON containing `text`, optional `voice`, optional `model`, and extra fields from `TTS_OPTIONS`. Return raw MP3 or WAV bytes with an audio content type. Authentication, if configured, is `Authorization: Bearer ...`. URLs may not embed credentials, query parameters, or fragments. Only loopback HTTP and remote HTTPS are accepted; redirects are disabled.

There are several projects called Voicebox. An OpenAI-compatible installation can use the first adapter. A service that returns a generation ID, a JSON audio URL, base64, or requires custom authentication needs a local adapter that translates this contract and returns audio bytes. These APIs are not assumed to be interchangeable. Such an adapter also makes other cloud or local voice engines usable without changing the interface. Never place provider keys in browser code.

Voice audio is limited to 16 MiB per request and requests time out. Provider error bodies are not returned to the interface. The default does not generate paid acknowledgment clips at startup; `KITT_WARM_VOICE_CACHE=1` explicitly enables that optional cache and can make billable requests.
