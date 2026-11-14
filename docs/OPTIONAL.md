# Optional integrations

The basic Mac browser path does not require these components.

## Work integrations

The retained advanced host adapters support `KITT_BRAIN=codex` or `KITT_BRAIN=responses`. They require your own compatible CLI/session, model access, and connector setup. Set `KITT_CODEX_COMMAND` to your installed executable and `KITT_MODEL` to an available model. Responses also requires your own `OPENAI_API_KEY`. These adapters can read explicitly available work sources and create local reminders. They are version-sensitive and are not the default setup path. No account, connector session, or service binding is distributed.

Set `KITT_LOCATION` yourself for location-dependent queries; no personal location is supplied. Regional traffic integrations retain public California CHP/Caltrans sources; they do not determine your location. Use the default chat adapter if you do not need connected work sources.

## Wake words

`python3 scripts/install-wake-v1.py` installs a pinned local keyword runtime and checksum-verified models into ignored `.kitt-state/`. Read its dependencies before installing. It uses the microphone while the KITT screen is active and listening is enabled, or during an explicitly started headless session. P4 pauses listening. Activated requests use the independently configured transcription service.

## Headless sessions and SidePulse

Run the host on your Mac with `npm start`, then use a second terminal:

```sh
npm run headless -- run
npm run headless -- status
npm run headless -- pause
npm run headless -- resume
npm run headless -- stop
```

`start` is also accepted as an alias for `run`. When the host is offline, `run`, `start`, and `resume` start the already-installed `com.carthing.kitt` Mac LaunchAgent and wait up to 20 seconds for readiness. They do not install a service, replace its configuration, or restart a running host. An absent service requires `npm start` manually. `status`, `pause`, and `stop` never start the host. `stop` ends the headless session without quitting the host. The CLI reads the same private `.env` and `KITT_PORT` as the host; an installed service must use that same port. Use `KITT_MODE=browser` when no Car Thing is attached. Wake models, microphone permission, and your transcription service must be configured before voice requests work. Headless mode always selects a Mac microphone, works without an open browser or connected Car Thing, and is off again after a host restart.

Pause cancels the current request, releases the microphone, and holds SidePulse dark. Resume rearms wake listening. Stop restores the screen's listening preference and microphone route; an active KITT screen can then resume its usual listening behavior. Browser heartbeats and Car Thing disconnection do not resume a paused headless session.

For LED output, install and run the [official SidePulse companion](https://github.com/inteliwear/sidepulse#installation) on that Mac, enable its outputs, connect exactly one **SidePulse Pro with a drive connection**, and choose **SidePulse** or **both** in `npm run setup`. It saves `KITT_SIDEPULSE=1` privately. Test the connection in **Details → Settings**, or run `npm run leds:test`. Dot and direct USB-control connections are unsupported. KITTKARR does not install or update SidePulse firmware or the companion.

SidePulse follows the measured speech waveform, shows a red sweep while headless wake listening is active, and flickers during transcription and thinking. It preserves the existing brightness and restores the preceding LED program when released. Each animation is bounded to 512 bytes, ends off, and uses a short ownership hold so a disconnected host cannot leave a permanent animation running. Disabling output in the companion service is respected on the next write check, within the current short animation window; it clears ownership without replaying a visible saved program. An unplugged device, multiple matching devices, or an unavailable service does not interrupt the voice assistant. Session and LED status are available through the CLI and `/api/state`.

## Camera effect

The Yautja camera integration is retained as an optional extension. It needs a compatible renderer exposing `yautja.render.Renderer` and `yautja.semantic.Subject`; the renderer is not bundled, downloaded from a personal repository, or assumed to be installed. Set `YAUTJA_PACKAGE` to your trusted local package directory, then run `node scripts/setup-yautja-v1.mjs`. Its additional dependencies are listed in `requirements-yautja-v1.txt`. The native segmentation helper requires macOS and Xcode command-line tools. Compatibility with arbitrary renderer versions is not guaranteed.

Camera frames stay in memory and the camera is released when the viewer leaves. This is a simulated thermal appearance, not a temperature sensor.

Optional Python checks: `python3 tests/wake-audio-v1.py`, `python3 tests/wake-endpoint-v1.py`, and `python3 tests/yautja-styles-v1.py`. The camera test requires the chosen renderer; wake tests require macOS system speech, FFmpeg, the wake runtime, and downloaded models (the endpoint test also needs NumPy). They are hardware/model integration checks and are not run by the portable suite. `npm test` includes the LCARS data checks.
