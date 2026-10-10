# Car Thing tethered to a Mac

This integration targets **already unlocked Car Thing hardware running compatible ClaudeThing firmware**, with its Mac collector installed. It is not an installer for stock Spotify firmware. Expected device components are `/run/claudething-ui`, the browser service `chromium-kiosk.service`, ADB reverse forwarding, and a local dashboard on port 8080. The installer verifies `ID=claudething` before modifying the dashboard.

1. Complete the Mac dependencies in [SETUP.md](SETUP.md), plus Android platform tools (`brew install --cask android-platform-tools`) and Xcode command-line tools (`xcode-select --install`).
2. Connect with a data-capable USB cable. Run `adb devices` and confirm an authorized device appears.
3. Run `npm run setup` and choose **USB Car Thing**. If `.env` already exists, edit `KITT_MODE=carthing`, `KITT_ADB_SERIAL` from `adb devices`, and `KITT_INPUT_SOURCE=auto` yourself. Never publish the serial.
4. Configure transcription, conversation, and optional voice output as in [SETUP.md](SETUP.md) and [VOICE.md](VOICE.md).
5. Run `npm run device:build` and `npm run device:dashboard`.
6. Run `npm run device:install`. This requires the existing collector UI at `~/Library/Application Support/CarThingCollector/device-ui`. It backs up that UI and the device UI privately, then installs a user LaunchAgent and updates the dashboard. Do not also run `npm start` while the service owns port 4180.

The Mac runs the assistant, transcription, and playback. Car Thing supplies the screen and optionally the microphone over USB. Replies use the Mac's selected speakers or Bluetooth output. No device serial, pairing token, or account endpoint is bundled.

Top button 3 opens KITT. The front button or dial starts/stops a request; turning the dial changes reply volume. P1 switches fictional roleplay; P4 pauses/resumes listening. Other top buttons navigate the dashboard and LCARS. Default runtime configuration contains no collector endpoints or tokens, so usage data requires your own compatible collector; demo data is labeled. The installer preserves existing collector pairing configuration.

The optional Yautja camera mode requires its separately installed renderer and model dependencies. It is not part of the basic setup. See [OPTIONAL.md](OPTIONAL.md).

## Restore and troubleshooting

Run `npm run device:restore` to stop the installed service and restore the saved dashboard. It keeps private backups and user state. Keep the repository in place while the LaunchAgent is installed. Reinstall if you move it or change your Node installation.

If disconnected, check `adb devices`, the USB cable, and `KITT_ADB_SERIAL`. The bridge checks actual HTTP reachability through the tunnel and repairs it when necessary. If firmware or collector paths differ, do not run the installer: adapt the integration to that firmware first. Hardware installation and macOS permission prompts must be verified on your own Mac and device.
