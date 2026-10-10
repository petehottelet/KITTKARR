# Optional integrations

The basic Mac browser path does not require these components.

## Work integrations

The retained advanced host adapters support `KITT_BRAIN=codex` or `KITT_BRAIN=responses`. They require your own compatible CLI/session, model access, and connector setup. Set `KITT_CODEX_COMMAND` to your installed executable and `KITT_MODEL` to an available model. Responses also requires your own `OPENAI_API_KEY`. These adapters can read explicitly available work sources and create local reminders. They are version-sensitive and are not the default setup path. No account, connector session, or service binding is distributed.

Set `KITT_LOCATION` yourself for location-dependent queries; no personal location is supplied. Regional traffic integrations retain public California CHP/Caltrans sources; they do not determine your location. Use the default chat adapter if you do not need connected work sources.

## Wake words

`python3 scripts/install-wake-v1.py` installs a pinned local keyword runtime and checksum-verified models into ignored `.kitt-state/`. Read its dependencies before installing. It uses the microphone only while the KITT screen is active and listening is enabled. P4 pauses listening. Activated requests use the independently configured transcription service.

## Camera effect

The Yautja camera integration is retained as an optional extension. It needs a compatible renderer exposing `yautja.render.Renderer` and `yautja.semantic.Subject`; the renderer is not bundled, downloaded from a personal repository, or assumed to be installed. Set `YAUTJA_PACKAGE` to your trusted local package directory, then run `node scripts/setup-yautja-v1.mjs`. Its additional dependencies are listed in `requirements-yautja-v1.txt`. The native segmentation helper requires macOS and Xcode command-line tools. Compatibility with arbitrary renderer versions is not guaranteed.

Camera frames stay in memory and the camera is released when the viewer leaves. This is a simulated thermal appearance, not a temperature sensor.

Optional Python checks: `python3 tests/wake-audio-v1.py`, `python3 tests/wake-endpoint-v1.py`, and `python3 tests/yautja-styles-v1.py`. The camera test requires the chosen renderer; wake tests require macOS system speech, FFmpeg, the wake runtime, and downloaded models (the endpoint test also needs NumPy). They are hardware/model integration checks and are not run by the portable suite. `npm test` includes the LCARS data checks.
