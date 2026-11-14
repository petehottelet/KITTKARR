# Car Thing, SidePulse, or both

1. Install Node.js 22.12 or later and FFmpeg. With Homebrew: `brew install node ffmpeg`.
2. Download this repository, open Terminal in its directory, and run `npm ci`.
3. Run `npm run setup`. Choose **Car Thing**, **SidePulse**, **both**, or **Mac browser only**. Setup creates or updates the private `.env`, changing hardware settings while retaining voice, model, account settings and comments.
4. Follow any prerequisite messages. SidePulse needs the [official companion](https://github.com/inteliwear/sidepulse#installation) with output enabled and one mounted SidePulse Pro. Car Thing needs compatible ClaudeThing firmware, ADB authorization and its existing Mac collector; see [CARTHING.md](CARTHING.md). Selecting both enables the two outputs in one host.
5. Setup offers to install/start KITT at login. This requires Apple command-line tools (`xcode-select --install`); it builds the microphone-permission and audio-clock helpers on your Mac. For Car Thing it also builds and backs up the dashboard before installing. You can skip installation and run `npm start` in Terminal instead.
6. Run `npm start` to open **http://127.0.0.1:4180**. An existing compatible host is reused; an installed stopped service is started. A foreground host stays attached to Terminal until Control-C. `KITT_OPEN_BROWSER=0` disables automatic browser opening.

Open **Details → Settings**. **Test voice** uses the selected voice (Mac system voice by default). **Test LEDs** runs a short red sweep and restores the preceding SidePulse display. Both work before configuring conversation or microphone transcription; the LED test never requests speech. Type “What time is it?” to try a complete local spoken answer. Sound comes from the Mac's selected output; Car Thing and SidePulse visualize the same reply. The server listens only on loopback.

## Hardware checks and changes

`npm run doctor` checks only the hardware you selected and explains missing dependencies. **Check connection** in Settings distinguishes a stopped SidePulse service, disabled output, missing drive, multiple Pro devices and unsupported devices. `npm run leds:test` works with the running host or, if the host is stopped, directly through the companion service.

Rerun `npm run setup` to add/remove either output. Existing chat, voice and transcription settings are retained. Restart the host to apply changes: rerun `npm run host:install` for a login service, or stop the foreground host and run `npm start`. Setup can apply changes to an already-installed dashboard without replacing its original backup. For noninteractive configuration use `npm run setup -- --hardware sidepulse --no-install`; accepted choices are `carthing`, `sidepulse`, `both`, and `browser`.

SidePulse-only use needs no Car Thing, ADB, collector, or display window. For voice listening without a window, configure transcription and optional wake models below, then use `npm run headless -- run`. Headless sessions always use a Mac microphone, including when both devices are attached. Pause and stop are described in [OPTIONAL.md](OPTIONAL.md).

## Run at login

`npm run host:install` installs or updates this checkout's Mac service for any hardware choice. It retains a preceding service configuration and refuses to replace a service owned by another checkout. Keep the project in its permanent folder; rerun installation after moving it or changing Node. Stop a foreground host before installing the service.

`npm run host:uninstall` removes a standalone login service and restores a preceding service if one was saved. Private configuration, models and recordings remain. If the Car Thing dashboard is installed, run `npm run device:restore` first. The service starts the host; wake listening without a screen still requires an explicit headless session. The optional local Qwen service is started separately with `npm run voice:local`.

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
- Port occupied: `npm start` reuses a compatible host. If it reports an older host or changed hardware, restart that host first. Device/dashboard integrations currently use port 4180; retain that port for Car Thing.
- LEDs dark: use **Details → Settings → Check connection**, or `npm run doctor`. Confirm SidePulse companion output is enabled. Test LEDs independently of the voice service. Sleep/wake behavior and drive availability also depend on the companion's settings.
- Local state, reminders, audio caches, and backups live in ignored `.kitt-state/`. Never share that directory or `.env`.
