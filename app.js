(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const signal = window.KittSignal;
  const demoVoice = new Blob([signal.createDemoWav()], { type: 'audio/wav' });
  const audio = $('audio');
  const playButton = $('play');
  const stopButton = $('stop');
  const seek = $('seek');
  const fileInput = $('audio-file');
  const drop = $('file-drop');
  const feedback = $('feedback');
  const sensitivity = $('sensitivity');
  const volume = $('volume');
  const segments = [];
  let context;
  let analyser;
  let gain;
  let samples;
  let objectUrl;
  let loaded = false;
  let loading = false;
  let frame = 0;
  let previousTime = 0;
  let level = 0;
  let dragDepth = 0;
  let sourceVersion = 0;
  let stopStream = null;

  for (let column = 0; column < 3; column++) {
    const element = document.createElement('div');
    element.className = 'led-column';
    const columnSegments = [];
    for (let index = 0; index < 20; index++) {
      const led = document.createElement('span');
      led.className = 'led';
      element.append(led);
      columnSegments.push(led);
    }
    $('led-array').append(element);
    segments.push(columnSegments);
  }

  // A failed or unavailable storage API must never prevent the panel from working.
  let saved = {};
  try {
    const stored = JSON.parse(localStorage.getItem('kitt-switches') || '{}');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) saved = stored;
  } catch { /* Use initial states. */ }
  document.querySelectorAll('[data-switch]').forEach((button) => {
    if (typeof saved[button.dataset.switch] === 'boolean') button.setAttribute('aria-pressed', String(saved[button.dataset.switch]));
    button.addEventListener('click', () => {
      const on = button.getAttribute('aria-pressed') !== 'true';
      button.setAttribute('aria-pressed', String(on));
      saved[button.dataset.switch] = on;
      try { localStorage.setItem('kitt-switches', JSON.stringify(saved)); } catch { /* Session-only state is sufficient. */ }
    });
  });

  function message(text, error = false) {
    feedback.textContent = text;
    feedback.classList.toggle('is-error', error);
  }

  function status(text, active = false) {
    const statusElement = $('signal-status');
    statusElement.querySelector('span').textContent = text;
    statusElement.classList.toggle('is-playing', active);
  }

  function fillRange(input) {
    const percent = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100;
    input.style.setProperty('--fill', `${percent}%`);
  }

  function paint(value) {
    segments.forEach((column, columnIndex) => {
      const columnLevel = value * (columnIndex === 1 ? 1 : .76);
      column.forEach((led, index) => {
        const intensity = signal.segmentIntensity(columnLevel, index).toFixed(2);
        if (led.style.getPropertyValue('--intensity') !== intensity) led.style.setProperty('--intensity', intensity);
        const lit = Number(intensity) > 0 ? '1' : '0';
        if (led.style.getPropertyValue('--lit') !== lit) led.style.setProperty('--lit', lit);
        const color = signal.segmentColor(columnLevel, index);
        if (led.style.getPropertyValue('--led-color') !== color) led.style.setProperty('--led-color', color);
      });
    });
  }

  function clearDisplay() {
    cancelAnimationFrame(frame);
    frame = 0;
    level = 0;
    previousTime = 0;
    paint(0);
  }

  function animate(timestamp) {
    if (!analyser || audio.paused || audio.ended) { clearDisplay(); return; }
    const delta = previousTime ? Math.min((timestamp - previousTime) / 1000, .1) : 1 / 60;
    previousTime = timestamp;
    analyser.getFloatTimeDomainData(samples);
    const target = signal.amplitudeToLevel(signal.rms(samples), Number(sensitivity.value));
    level = signal.smoothLevel(level, target, delta);
    paint(level);
    frame = requestAnimationFrame(animate);
  }

  async function readyAudio() {
    if (!context) {
      const AudioContextType = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextType) throw new Error('audio-unavailable');
      context = new AudioContextType();
      analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      samples = new Float32Array(analyser.fftSize);
      gain = context.createGain();
      gain.gain.value = Number(volume.value);
      const source = context.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(gain);
      gain.connect(context.destination);
    }
    if (context.state === 'suspended') await context.resume();
  }

  function updatePlayback() {
    const playing = !audio.paused && !audio.ended;
    playButton.classList.toggle('is-playing', playing);
    playButton.querySelector('span').textContent = playing ? 'Pause' : 'Play';
    playButton.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
    playButton.disabled = !loaded || loading;
    stopButton.disabled = !loaded || loading;
    seek.disabled = !loaded || !Number.isFinite(audio.duration) || audio.duration <= 0;
    if (playing) status('VOICE ACTIVE', true);
    else if (loading) status('LOADING');
    else status(loaded ? 'READY' : 'STANDBY');
  }

  function updateTime() {
    const current = audio.currentTime || 0;
    const duration = audio.duration;
    $('elapsed').textContent = signal.formatTime(current);
    $('duration').textContent = signal.formatTime(duration);
    seek.value = Number.isFinite(duration) && duration > 0 ? current / duration * 1000 : 0;
    seek.setAttribute('aria-valuetext', `${signal.formatTime(current)} of ${signal.formatTime(duration)}`);
    fillRange(seek);
  }

  async function play() {
    const version = sourceVersion;
    try {
      await readyAudio();
      if (version !== sourceVersion) return;
      if (audio.ended) audio.currentTime = 0;
      await audio.play();
    } catch (error) {
      if (version !== sourceVersion || error.name === 'AbortError') return;
      message('Playback could not start. Press Play again, or try a different audio file.', true);
      clearDisplay();
      updatePlayback();
    }
  }

  function pause() {
    audio.pause();
    clearDisplay();
    updatePlayback();
  }

  function loadSource(source, name, demo = false) {
    sourceVersion++;
    if (stopStream) stopStream();
    audio.pause();
    clearDisplay();
    loaded = false;
    loading = true;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = source instanceof Blob || (window.MediaSource && source instanceof MediaSource) ? URL.createObjectURL(source) : null;
    $('track-name').textContent = name;
    $('track-name').title = name;
    $('file-action').textContent = 'Choose another file';
    message(demo ? 'Demo tones ready. Press Play, or choose your own audio file.' : 'Your audio stays on this device. Press Play when ready.');
    audio.src = objectUrl || source;
    audio.load();
    updatePlayback();
    updateTime();
  }

  function loadFile(file) {
    if (!file) return;
    if (!file.size) { message('This file is empty. Choose an audio file with a recording.', true); return; }
    const audioExtension = /\.(mp3|wav|wave|ogg|oga|m4a|aac|flac|webm|aif|aiff|opus|mp4)$/i;
    if (!file.type.startsWith('audio/') && !audioExtension.test(file.name)) {
      message('Choose an audio file, such as MP3, WAV, M4A, or OGG.', true);
      return;
    }
    loadSource(file, file.name);
  }

  fileInput.addEventListener('change', () => { loadFile(fileInput.files[0]); fileInput.value = ''; });
  drop.addEventListener('dragenter', (event) => { event.preventDefault(); dragDepth++; drop.classList.add('is-dragging'); });
  drop.addEventListener('dragover', (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
  drop.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove('is-dragging'); } });
  drop.addEventListener('drop', (event) => {
    event.preventDefault(); dragDepth = 0; drop.classList.remove('is-dragging');
    loadFile(event.dataTransfer.files[0]);
  });
  // Prevent an accidental drop outside the target from navigating away from the panel.
  window.addEventListener('dragover', (event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
  window.addEventListener('drop', (event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });

  $('demo').addEventListener('click', async () => {
    try {
      // Resume the audio context directly inside the user gesture.
      await readyAudio();
      loadSource(demoVoice, 'Demo tones', true);
      await play();
    } catch {
      message('Audio is unavailable in this browser. Try opening the panel in Chrome, Edge, Firefox, or Safari.', true);
    }
  });

  // Speech generation runs through the server, which holds the voice service key.
  const speechForm = $('speech');
  const speechText = $('speech-text');
  let speaking = false;

  function updateSpeech() {
    $('speech-count').textContent = `Sent to voice service · ${speechText.value.length} / ${speechText.maxLength}`;
    $('speak').disabled = speaking || !speechText.value.trim();
  }

  async function requestSpeech(text) {
    let response;
    try {
      response = await fetch('api/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    } catch {
      throw new Error('The speech service could not be reached. Check your connection and try again.');
    }
    if (!response.ok) {
      const { error } = await response.json().catch(() => ({}));
      throw new Error(error || 'Speech could not be generated.');
    }
    return response;
  }

  // Plays speech while it is still arriving. Browsers that cannot stream this format wait for the whole clip.
  async function playSpeech(response, text, version) {
    const type = (response.headers.get('content-type') || '').split(';')[0].trim();
    if (!response.body || !window.MediaSource || !MediaSource.isTypeSupported(type)) {
      const speech = await response.blob();
      if (version !== sourceVersion) return;
      loadSource(speech, text);
      message('Speech generated. Press Play to hear it again, or type another line.');
      await play();
      return;
    }
    const reader = response.body.getReader();
    const mediaSource = new MediaSource();
    loadSource(mediaSource, text);
    message('Speaking…');
    // Choosing another source cancels the stream, including while it waits to open.
    let cancelled = false;
    let opened;
    const open = new Promise((resolve) => { opened = resolve; mediaSource.addEventListener('sourceopen', resolve, { once: true }); });
    const stop = () => { cancelled = true; opened(); void reader.cancel().catch(() => {}); };
    stopStream = stop;
    try {
      await open;
      if (cancelled) return;
      const buffer = mediaSource.addSourceBuffer(type);
      const append = (chunk) => new Promise((resolve, reject) => {
        buffer.addEventListener('updateend', resolve, { once: true });
        buffer.addEventListener('error', reject, { once: true });
        buffer.appendBuffer(chunk);
      });
      for (let started = false; ;) {
        const { done, value } = await reader.read();
        if (cancelled) return;
        if (done) break;
        await append(value);
        if (!started) { started = true; void play(); }
      }
      if (mediaSource.readyState === 'open') mediaSource.endOfStream();
      message('Speech generated. Press Play to hear it again, or type another line.');
    } catch {
      if (cancelled) return;
      // Keep the audio received before the interruption playable.
      try { if (mediaSource.readyState === 'open') mediaSource.endOfStream(); } catch { /* The partial clip may still play. */ }
      message('The speech stream was interrupted. The audio received so far can still be played.', true);
    } finally {
      if (stopStream === stop) stopStream = null;
    }
  }

  speechText.addEventListener('input', updateSpeech);
  speechText.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); speechForm.requestSubmit(); }
  });
  speechForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = speechText.value.trim();
    if (!text || speaking) return;
    const version = sourceVersion;
    speaking = true;
    updateSpeech();
    message('Generating speech…');
    try {
      // Resume the audio context inside the user gesture so playback can start when the speech arrives.
      await readyAudio().catch(() => {});
      const response = await requestSpeech(text);
      if (version !== sourceVersion) { void response.body?.cancel(); return; }
      await playSpeech(response, text, version);
    } catch (error) {
      if (version === sourceVersion) message(error.message, true);
    } finally {
      speaking = false;
      updateSpeech();
    }
  });
  if (location.protocol.startsWith('http')) {
    fetch('api/speech').then((response) => (response.ok ? response.json() : {})).then(({ available }) => {
      speechForm.hidden = !available;
    }).catch(() => {});
  }
  updateSpeech();

  playButton.addEventListener('click', () => { if (audio.paused || audio.ended) void play(); else pause(); });
  stopButton.addEventListener('click', () => { audio.pause(); audio.currentTime = 0; clearDisplay(); updateTime(); updatePlayback(); });
  $('loop').addEventListener('click', () => {
    audio.loop = !audio.loop;
    $('loop').setAttribute('aria-pressed', String(audio.loop));
  });
  seek.addEventListener('input', () => {
    if (Number.isFinite(audio.duration)) { audio.currentTime = Number(seek.value) / 1000 * audio.duration; updateTime(); }
  });
  sensitivity.addEventListener('input', () => {
    $('sensitivity-value').textContent = `${Number(sensitivity.value).toFixed(1)}×`;
    fillRange(sensitivity);
  });
  volume.addEventListener('input', () => {
    $('volume-value').textContent = `${Math.round(Number(volume.value) * 100)}%`;
    if (gain) gain.gain.setTargetAtTime(Number(volume.value), context.currentTime, .025);
    fillRange(volume);
  });

  audio.addEventListener('loadedmetadata', () => { loaded = true; loading = false; updateTime(); updatePlayback(); });
  audio.addEventListener('durationchange', updateTime);
  audio.addEventListener('timeupdate', updateTime);
  audio.addEventListener('playing', () => {
    loading = false;
    loaded = true;
    updatePlayback();
    if (!frame) frame = requestAnimationFrame(animate);
  });
  audio.addEventListener('pause', () => { clearDisplay(); updatePlayback(); });
  audio.addEventListener('ended', () => { clearDisplay(); updatePlayback(); updateTime(); });
  audio.addEventListener('waiting', () => { status('BUFFERING'); clearDisplay(); });
  audio.addEventListener('error', () => {
    if (!audio.getAttribute('src')) return;
    loaded = false; loading = false; clearDisplay(); updatePlayback();
    message('This audio file could not be read. Try another file, or convert it to MP3 or WAV.', true);
  });

  function setPanelView(enabled) {
    document.body.classList.toggle('panel-view', enabled);
    $('fullscreen').querySelector('span').textContent = enabled ? 'Exit panel view' : 'Panel view';
    $('fullscreen').querySelector('use').setAttribute('href', enabled ? '#i-close' : '#i-expand');
    $('fullscreen').setAttribute('aria-pressed', String(enabled));
  }
  $('fullscreen').addEventListener('click', async () => {
    const enabled = !document.body.classList.contains('panel-view');
    setPanelView(enabled);
    try {
      if (enabled && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else if (!enabled && document.fullscreenElement) await document.exitFullscreen();
    } catch { /* The in-page panel view also works when fullscreen is unavailable. */ }
  });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) setPanelView(false); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setPanelView(false);
    if (event.code === 'Space' && !/^(INPUT|BUTTON|A|TEXTAREA|SELECT)$/.test(event.target.tagName)) {
      event.preventDefault();
      if (loaded) { if (audio.paused) void play(); else pause(); }
    }
  });
  window.addEventListener('pagehide', () => { audio.pause(); clearDisplay(); });
  document.querySelectorAll('input[type="range"]').forEach(fillRange);
  paint(0);
  loadSource(demoVoice, 'Demo tones', true);
})();
