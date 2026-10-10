# Mac browser setup

1. Install Node.js 22.12 or later and FFmpeg. With Homebrew: `brew install node ffmpeg`.
2. Download this repository, open Terminal in its directory, and run `npm ci`.
3. Run `npm run setup` and choose **Mac browser**. It creates an ignored, private `.env` and preserves an existing one.
4. Run `npm start` and open **http://127.0.0.1:4180** in a browser. Keep Terminal running. Stop with Control-C.

No Car Thing, native app installation, or cloud account is needed for the display, typed clock questions, and **Settings → Test voice**. Sound comes from the Mac's selected output. The server listens only on loopback; it is not a public web service.

## Conversation

Configure a local or cloud chat-completions service in `.env`:

```dotenv
CHAT_ENDPOINT=http://127.0.0.1:1234/v1/chat/completions
CHAT_MODEL=YOUR_INSTALLED_MODEL
CHAT_API_KEY=
```

Use the exact endpoint and model supplied by your chosen service. Cloud endpoints require HTTPS and may charge for requests. No specific chat service is installed or selected automatically. Restart the host after editing settings. The default chat adapter has no work-account access, tools, or live information. Its conversation history is bounded and held in memory. The display's legacy follow-up shortcuts require an explicitly configured advanced work integration; the default adapter cannot read email or calendars or create reminders.

## Microphone input

The Mac captures audio for the browser interface. Allow Terminal microphone access in **System Settings → Privacy & Security → Microphone** when prompted. Select the input in macOS Sound settings. The default browser mode uses that selected input. Press the talk button to start and again to finish; typed requests remain available if speech recognition is not configured.

Choose one transcription path:

- **Local:** install a compatible `whisper-cli`, download a model following that project's instructions, then set `KITT_WHISPER` to the executable and `KITT_WHISPER_MODEL` to the model file. Set `KITT_TRANSCRIPTION_PROVIDER=local`. Audio stays on the Mac for transcription.
- **Cloud:** set `KITT_TRANSCRIPTION_PROVIDER=openai`, `OPENAI_API_KEY`, and `OPENAI_TRANSCRIPTION_MODEL` to a transcription model available to your account. Activated recordings are sent to that service. These settings do not choose the voice-output provider.

For separately named microphone permissions, install Xcode command-line tools (`xcode-select --install`), run `node scripts/build-mac-host-v1.mjs`, then run `.kitt-state/KITT.app/Contents/MacOS/KITT` instead of `npm start`. Optional `node scripts/build-mac-player-v1.mjs` enables a native playback clock for tighter LED synchronization. These helpers compile locally; no binaries are distributed.

Wake-word listening is optional and needs additional local models. The supplied `scripts/install-wake-v1.py` installs its declared model/runtime dependencies; inspect it and run it only if you want that feature. Push-to-talk and typed input work independently. Entering an active KITT screen permits the configured listener; P4 pauses it, and leaving the screen releases capture.

## Audio panel only

`npm run preview` serves **http://127.0.0.1:4173**, an audio-reactive panel for uploaded audio and generated test tones. This works without FFmpeg, a microphone, an assistant, or a voice account. HTTP speech generation here is optional; the Mac system-voice path belongs to the assistant at port 4180. `npm run build` creates only this static panel in `dist`.

## Troubleshooting

- No voice: check the Mac output and FFmpeg installation; test `say 'Systems online'`.
- No input: check microphone permission and the selected input, then restart Terminal/the host.
- Cannot transcribe: verify the local model/executable, or the cloud key and model. No cloud fallback occurs automatically.
- Cannot generate speech: check [voice settings](VOICE.md), confirm the chosen service is running, and restart.
- Port occupied: stop the other host. Device/dashboard integrations currently use port 4180; retain that port for Car Thing.
- Local state, reminders, audio caches, and backups live in ignored `.kitt-state/`. Never share that directory or `.env`.
