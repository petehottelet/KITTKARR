// Revision 4. Include the lower-left live microphone waveform.
import { readFile, writeFile } from 'node:fs/promises';
const original = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const panel = original.match(/<div class="panel-wrap">[\s\S]*?<\/section>/)?.[0].replace(/<\/section>$/, '').replace(/aria-pressed="true" data-switch="p4"/, 'aria-pressed="false" aria-label="P4: Microphone not listening" data-switch="p4"');
if (!panel) throw new Error('The KITT instrument could not be found.');
const html = `<!doctype html>
<!-- Device interface revision 4. Gray microphone waveform and a mesh thinking indicator. -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#070708">
<title>K.I.T.T. — Car Thing</title><link rel="icon" href="assets/icon.png"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="device-v1.css"><script src="signal.js" defer></script><script src="device-v1.js" defer></script></head>
<body class="device-view">
<nav class="device-tools" aria-label="KITT mode"><button id="back-to-dashboard">Back</button><button id="details-toggle" aria-expanded="false">Details</button></nav>
<main class="device-stage">
  <section class="device-instrument" aria-label="KITT voicebox">${panel}</section>
  <section class="conversation" aria-label="Voice assistant">
    <header class="device-header"><h1>K.I.T.T.</h1><button id="settings-toggle" class="quiet-control" aria-label="Open connections and sound settings" aria-expanded="false">Settings</button></header>
    <div class="connection-line"><span id="connection-light" aria-hidden="true"></span><span id="connection">Connecting to Mac…</span><time id="clock"></time></div>
    <div id="conversation-body" class="conversation-body" tabindex="0">
      <p id="heard" class="heard" hidden></p>
      <p id="reply" class="reply" aria-live="polite">Ready when you are, Driver.</p>
      <p id="status" class="assistant-status" role="status">Connecting…</p>
      <div id="sources" class="sources"></div>
    </div>
    <section id="settings" class="settings" hidden aria-label="Connections and sound">
      <h2>Connections & sound</h2><div id="connection-details"></div>
      <label for="host-volume">Mac reply volume <output id="volume-label">70%</output></label><input id="host-volume" type="range" min="0" max="1" step="0.05" value="0.7">
      <p>Replies use your Mac’s selected speaker or Bluetooth audio device.</p><button id="sound-test" class="secondary-control">Test voice</button>
    </section>
    <section id="reminder-panel" class="reminder-panel" hidden aria-label="Reminders"><h2>Reminders</h2><div id="reminder-list"></div></section>
    <div class="quick-actions"><button id="follow-ups">Follow ups</button><button id="reminders-toggle" aria-expanded="false">Reminders <span id="reminder-count">0</span></button></div>
    <div class="voice-actions"><button id="talk" class="talk-control" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8"/></svg><span>Talk to K.I.T.T.</span></button><button id="cancel" class="cancel-control" aria-label="Stop listening or speaking" disabled>Stop</button></div>
    <p class="control-hint" id="control-hint">Press the dial to talk · press again to finish</p>
  </section>
</main>
<div id="mic-waveform" class="mic-waveform" role="img" aria-label="Microphone receiving sound" hidden><canvas id="mic-wave" width="208" height="104" aria-hidden="true"></canvas></div>
<div id="thinking-brain" class="thinking-brain" role="status" aria-label="KITT is thinking" hidden><canvas id="brain-mesh" width="208" height="184" aria-hidden="true"></canvas></div>
<div class="listening-strip"><button id="listen-state" disabled>Connecting to Mac…</button><button id="quick-stop" hidden>Stop</button></div>
<form id="text-form" class="text-form"><label for="text-input">Or type a request</label><div><input id="text-input" maxlength="4000" placeholder="What needs my attention today?" autocomplete="off"><button type="submit">Ask K.I.T.T.</button></div></form>
<noscript>Enable JavaScript to use the voice assistant.</noscript>
</body></html>`;
await writeFile(new URL('../device-v1.html', import.meta.url), html);
console.log('Built device-v1.html from the original KITT instrument.');
