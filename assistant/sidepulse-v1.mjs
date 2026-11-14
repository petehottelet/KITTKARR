import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {lstat, readFile} from 'node:fs/promises';
import signal from '../signal.js';

const programLimit = 512;
const brightnessValue = value => Math.round(signal.clamp(Number(value) || 0, 0, 255));

// The daemon owns the device. Never write directly to a mounted LED file.
export function sidePulseCommand(command, {socketPath = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'sidepulse', 'agent-monitor', 'program-status.sock')} = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks = [];
    let size = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(new Error('SidePulse service is unavailable.'));
      else resolve(value);
    };
    socket.setTimeout(1000, () => finish(true));
    socket.on('error', () => finish(true));
    socket.on('connect', () => socket.end(JSON.stringify({v: 1, ...command})));
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) finish(true);
      else chunks.push(chunk);
    });
    socket.on('end', () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        finish(value?.ok !== true, value);
      } catch { finish(true); }
    });
    socket.on('close', () => { if (!settled) finish(true); });
  });
}

function supportedTarget(state) {
  const devices = Array.isArray(state?.devices) ? state.devices.filter(device => device?.model === 'SidePulse Pro' && device.connection === 'drive') : [];
  const target = devices.length === 1 ? devices[0].target : null;
  return typeof target === 'string' && path.isAbsolute(target) && !target.includes('\0') ? target : null;
}

async function inspectTarget(target) {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size > programLimit) throw Error('Unsupported LED file.');
}

export async function diagnoseSidePulse({command = sidePulseCommand, inspect = inspectTarget} = {}) {
  let state;
  try { state = await command({type: 'get_state'}); }
  catch { return {ready: false, code: 'service-unavailable', message: 'Start or install the SidePulse companion: sidepulse.io. Then check again.'}; }
  if (state.outputs_enabled !== true) return {ready: false, code: 'output-disabled', message: 'Enable device output in the SidePulse companion, then check again.'};
  const devices = Array.isArray(state.devices) ? state.devices : [];
  const supported = devices.filter(device => device?.model === 'SidePulse Pro' && device.connection === 'drive');
  if (supported.length > 1) return {ready: false, code: 'multiple-devices', message: 'Connect one SidePulse Pro at a time.'};
  if (!supported.length) return {ready: false, code: devices.length ? 'unsupported-device' : 'disconnected', message: devices.length ? 'KITT supports SidePulse Pro in mounted-drive mode. Dot and direct USB mode are not supported.' : 'Connect a SidePulse Pro and wait for its drive to mount.'};
  const target = supportedTarget(state);
  try { if (!target) throw Error(); await inspect(target); }
  catch { return {ready: false, code: 'drive-unavailable', message: 'The SidePulse drive is unavailable. Reconnect the device, then check again.'}; }
  return {ready: true, code: 'ready', message: 'SidePulse Pro ready. Test LEDs to check the red sweep.'};
}

export async function previewSidePulse({connect = connectSidePulse, wait = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  const device = await connect();
  if (!device) throw Error('SidePulse is not ready. Run npm run doctor for connection help.');
  const window = idleSweepProgram(0, device.brightness);
  try {
    if (await device.write(window.program, (window.duration + 150) / 1000) === false) throw Error('SidePulse output is disabled.');
    await wait(window.duration);
  } finally { await device.write(device.previous, 0); }
}

export async function connectSidePulse({command = sidePulseCommand, inspect = inspectTarget, read = target => readFile(target, 'utf8')} = {}) {
  const state = await command({type: 'get_state'});
  const target = supportedTarget(state);
  if (state?.outputs_enabled !== true || !target) return null;
  await inspect(target);
  const previous = await read(target);
  if (typeof previous !== 'string' || Buffer.byteLength(previous) > programLimit) throw Error('Unsupported LED program.');
  return {
    previous,
    brightness: brightnessValue(/^brightness[ \t]+(\d+)/im.exec(previous)?.[1] ?? 255),
    async write(program, holdSeconds) {
      if (typeof program !== 'string' || Buffer.byteLength(program) > programLimit || !Number.isFinite(holdSeconds) || holdSeconds < 0 || holdSeconds > 2) throw Error('Invalid LED program.');
      // Revalidate every write, including restoration: the user can disable output
      // or unplug/swap devices while a session is active.
      const latest = await command({type: 'get_state'});
      if (supportedTarget(latest) !== target) throw Error('SidePulse device changed.');
      await inspect(target);
      if (latest.outputs_enabled !== true) {
        await command({type: 'write_led', target, program: 'off', hold_seconds: 0});
        return false;
      }
      await command({type: 'write_led', target, program, hold_seconds: holdSeconds});
      return true;
    }
  };
}

function finiteProgram(frames, brightness) {
  const lines = [`brightness ${brightnessValue(brightness)}`];
  let duration = 0;
  for (const frame of frames) {
    if (Buffer.byteLength([...lines, frame.text, 'off'].join('\n')) > programLimit) break;
    lines.push(frame.text);
    duration += frame.ms;
  }
  return {program: [...lines, 'off'].join('\n'), duration};
}

export function speechProgram(speech, position, brightness = 255) {
  if (!Number.isFinite(position) || position < 0 || !(speech?.durationMs > position) || !(speech.stepMs > 0) || !speech.levels?.length) return null;
  const frames = [];
  const length = Math.min(800, speech.durationMs - position);
  for (let offset = 0; offset < length; offset += 50) {
    const ms = Math.min(50, length - offset);
    const colors = [];
    let level = 1;
    for (let pair = 0; pair < 4; pair++) {
      level = Math.min(level, signal.amplitudeToLevel(signal.speechAmplitude(speech, position + offset - pair * 50), 1.15));
      const red = Math.round(255 * level * signal.clamp(level * 4 - pair));
      colors.push(`#${red.toString(16).padStart(2, '0')}0000`);
    }
    const commands = [`${colors[3] === '#000000' ? 'off' : colors[3]} ${ms}ms`];
    for (let pair = 0; pair < 3; pair++) {
      if (colors[pair] !== colors[3]) commands.push(`${3 - pair}:${colors[pair]}`, `${4 + pair}:${colors[pair]}`);
    }
    frames.push({text: commands.join(';'), ms});
  }
  return finiteProgram(frames, brightness);
}

export function idleSweepProgram(position, brightness = 255) {
  const elapsed = Math.max(0, Math.floor(Number(position) || 0));
  const frames = [];
  for (let frame = 0; frame < 8; frame++) {
    const phase = (Math.floor(elapsed / 120) + frame) % 14;
    const led = Math.min(phase, 14 - phase);
    const direction = phase > 0 && phase <= 7 ? 1 : -1;
    const ms = frame === 0 ? 120 - elapsed % 120 : 120;
    const commands = [`off ${ms}ms`, `${led}:#ff0000`];
    for (let tail = 1; tail <= 2; tail++) {
      const index = led - direction * tail;
      if (index >= 0 && index < 8) commands.push(`${index}:${tail === 1 ? '#440000' : '#100000'}`);
    }
    frames.push({text: commands.join(';'), ms});
  }
  return finiteProgram(frames, brightness);
}

export function thinkingProgram(brightness = 255, random = Math.random) {
  const frames = [];
  let previous = 0;
  for (let frame = 0; frame < 10; frame++) {
    let mask = 1 + Math.floor(signal.clamp(Number(random()) || 0, 0, 0.999999) * 254);
    if (mask === previous) mask = mask === 254 ? 1 : mask + 1;
    previous = mask;
    const commands = ['off 60ms'];
    for (let led = 0; led < 8; led++) if (mask & (1 << led)) commands.push(`${led}:#ff0000`);
    frames.push({text: commands.join(';'), ms: 60});
  }
  return finiteProgram(frames, brightness);
}

export class SidePulseVoice {
  constructor({enabled = process.env.KITT_SIDEPULSE === '1', connect = connectSidePulse, probe = diagnoseSidePulse, now = Date.now, random = Math.random} = {}) {
    Object.assign(this, {enabled, connect, probe, now, random});
    this.mode = enabled ? 'released' : 'disabled';
    this.retryAt = 0;
  }

  status() { return {enabled: this.enabled, connected: Boolean(this.device), mode: this.mode, error: this.error || null, health: this.health || null}; }

  async check() {
    this.health = this.enabled ? await this.probe() : {ready: false, code: 'disabled', message: 'SidePulse is off. Run npm run setup to add it.'};
    if (this.health.ready) {
      this.error = null;
      if (['unavailable', 'output-disabled'].includes(this.mode)) { this.mode = 'released'; this.retryAt = 0; }
    }
    return this.health;
  }

  update(speech, {idle = false, thinking = false, hold = false} = {}) {
    this.request = {speech: speech?.levels?.length && speech.stepMs > 0 && speech.durationMs > 0 ? speech : null, idle, thinking, hold};
    this.dirty = true;
    if (!this.work) this.work = Promise.resolve().then(async () => {
      try {
        while (this.dirty) { this.dirty = false; await this.sync(); }
      } finally { this.work = null; }
    });
    return this.work;
  }

  async sync() {
    if (!this.enabled) return;
    try {
      let wanted = this.request;
      const released = () => !this.request.speech && !this.request.idle && !this.request.thinking && !this.request.hold;
      if (released()) {
        if (this.wrote && this.device) await this.device.write(this.device.previous, 0);
        this.reset('released');
        this.retryAt = 0;
        return;
      }
      if (this.now() < this.retryAt) return;
      if (!this.device) {
        this.device = await this.connect();
        if (!this.device) { this.mode = 'unavailable'; this.retryAt = this.now() + 2000; return; }
        // A stopped request must never light the device after slow discovery.
        if (released()) { this.dirty = true; return; }
        wanted = this.request;
      }
      const now = this.now();
      const position = wanted.speech ? signal.speechPosition(wanted.speech, now, 0, 0) : null;
      const speaking = wanted.speech && position >= 0 && position < wanted.speech.durationMs;
      const mode = speaking ? 'speech' : wanted.thinking ? 'thinking' : wanted.idle ? 'idle' : 'quiet';
      const clip = speaking ? wanted.speech.id : null;
      if (mode === this.mode && clip === this.clip && now < this.refreshAt) return;
      if (mode !== this.mode) this.idleStartedAt = now;
      const window = speaking ? speechProgram(wanted.speech, position, this.device.brightness)
        : wanted.thinking ? thinkingProgram(this.device.brightness, this.random)
        : wanted.idle ? idleSweepProgram(now - this.idleStartedAt, this.device.brightness)
        : finiteProgram([{text: 'off 1000ms', ms: 1000}], this.device.brightness);
      if (!window?.duration) return;
      this.wrote = true;
      const written = await this.device.write(window.program, (window.duration + 150) / 1000);
      if (written === false) {
        this.reset('output-disabled');
        this.health = {ready: false, code: 'output-disabled', message: 'Enable device output in the SidePulse companion, then check again.'};
        this.retryAt = this.now() + 2000;
        return;
      }
      this.mode = mode;
      this.clip = clip;
      this.refreshAt = now + Math.max(25, window.duration - 160);
      this.error = null;
    } catch {
      this.reset('unavailable');
      this.error = 'SidePulse is unavailable; check its connection and companion service.';
      this.retryAt = this.now() + 2000;
    }
  }

  reset(mode) {
    this.device = null;
    this.wrote = false;
    this.clip = null;
    this.refreshAt = 0;
    this.mode = mode;
    this.error = null;
  }
}
