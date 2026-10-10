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
