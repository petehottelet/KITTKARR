import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import path from 'node:path';
import {speechConfig} from '../speech.mjs';

const choices = values => values.map(([id, label]) => ({id, label}));
export const FILTER_PRESETS = choices([['none', 'None'], ['old_radio', 'Old radio'], ['robot', 'Robot'], ['cheap_microphone', 'Cheap microphone'], ['phone', 'Phone'], ['low_quality_phone', 'Low quality phone'], ['bright_phone', 'Bright phone']]);
export const SPACE_PRESETS = choices([['none', 'None'], ['small_room', 'Small room'], ['big_room', 'Big room'], ['hall', 'Hall'], ['tunnel', 'Tunnel'], ['street', 'Street'], ['valley', 'Valley'], ['forest', 'Forest']]);
export const ROBOT_STYLES = choices([['subtle', 'Subtle'], ['metallic', 'Metallic'], ['digital', 'Digital'], ['protocol_droid', 'Protocol droid'], ['chorus', 'Light chorus'], ['johnny_five', 'Johnny 5']]);
export const DEFAULT_EFFECTS = Object.freeze({enabled: false, filter: 'none', space: 'none', robotStyle: 'subtle', wetMix: 1, outputGain: 1});

export function normalizeEffects(patch, base = DEFAULT_EFFECTS) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !Object.hasOwn(DEFAULT_EFFECTS, key))) throw Error('Unknown voice effects setting.');
  const result = {...base, ...patch};
  if (typeof result.enabled !== 'boolean') throw Error('Effects enabled must be true or false.');
  for (const [key, values] of [['filter', FILTER_PRESETS], ['space', SPACE_PRESETS], ['robotStyle', ROBOT_STYLES]]) if (!values.some(value => value.id === result[key])) throw Error('Choose a supported voice effect.');
  for (const [key, max] of [['wetMix', 1], ['outputGain', 1.5]]) if (typeof result[key] !== 'number' || !Number.isFinite(result[key]) || result[key] < 0 || result[key] > max) throw Error('Voice effect levels are outside the supported range.');
  return result;
}

export function effectsProfileKey(env = process.env) {
  const config = speechConfig(env);
  return createHash('sha256').update(JSON.stringify([config.provider, config.endpoint, config.voiceId, config.modelId, config.provider === 'system' ? env.KITT_MAC_VOICE || '' : ''])).digest('hex');
}

export class EffectsPreferences {
  constructor(directory, {key = effectsProfileKey()} = {}) {
    this.file = path.join(directory, 'voice-effects-v1.json'); this.key = key; this.profiles = {}; this.queue = Promise.resolve();
  }
  async load() {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (value.version !== 1 || !value.profiles || typeof value.profiles !== 'object' || Array.isArray(value.profiles)) throw Error();
      for (const [key, settings] of Object.entries(value.profiles)) { if (!/^[a-f0-9]{64}$/.test(key)) throw Error(); this.profiles[key] = normalizeEffects(settings); }
    } catch (error) { if (error.code !== 'ENOENT') throw Error('Saved voice effects could not be read.'); }
  }
  config() { return {...(this.profiles[this.key] || DEFAULT_EFFECTS)}; }
  snapshot() { return {...this.config(), filters: FILTER_PRESETS, spaces: SPACE_PRESETS, robotStyles: ROBOT_STYLES}; }
  set(patch) {
    normalizeEffects(patch);
    const change = this.queue.then(async () => {
      const settings = normalizeEffects(patch, this.config());
      const profiles = {...this.profiles, [this.key]: settings};
      await mkdir(path.dirname(this.file), {recursive: true, mode: 0o700});
      try {
        await writeFile(this.file + '.tmp', JSON.stringify({version: 1, profiles}), {mode: 0o600});
        await rename(this.file + '.tmp', this.file);
      } catch { throw Error('Voice effects could not be saved.'); }
      this.profiles = profiles;
      return this.snapshot();
    });
    this.queue = change.catch(() => {});
    return change;
  }
}

const room = {small_room: [0.037, 0.071, 0.20], big_room: [0.061, 0.113, 0.28], hall: [0.089, 0.173, 0.35], tunnel: [0.127, 0.251, 0.38], street: [0.043, 0.157, 0.14], valley: [0.211, 0.397, 0.29], forest: [0.097, 0.193, 0.12]};

// Speech is mono 16 kHz PCM in the host. Process the actual samples before
// calculating the LED envelope, so effects and their tails stay synchronized.
export function processPCM16(pcm, settings = DEFAULT_EFFECTS, rate = 16000) {
  const config = normalizeEffects(settings);
  if (!Buffer.isBuffer(pcm) || pcm.length % 2 || pcm.length > 16 * 1024 * 1024 || !Number.isInteger(rate) || rate < 8000 || rate > 96000) throw Error('Unsupported voice audio.');
  if (!config.enabled || (config.outputGain === 1 && (config.wetMix === 0 || (config.filter === 'none' && config.space === 'none')))) return Buffer.from(pcm);
  const count = pcm.length / 2;
  const tail = config.space !== 'none' && config.wetMix > 0 ? Math.round(rate * 0.9) : 0;
  const output = Buffer.alloc((count + tail) * 2);
  const history = new Float32Array(count + tail);
  let low = 0, high = 0, previous = 0;
  const band = {old_radio: [350, 2800, 1.7], cheap_microphone: [180, 4200, 1.4], phone: [300, 3300, 1], low_quality_phone: [550, 2300, 1.4], bright_phone: [550, 3900, 1]}[config.filter];
  const lowAlpha = band ? 1 - Math.exp(-2 * Math.PI * band[1] / rate) : 0;
  const highAlpha = band ? Math.exp(-2 * Math.PI * band[0] / rate) : 0;
  for (let i = 0; i < count + tail; i++) {
    const dry = i < count ? pcm.readInt16LE(i * 2) / 32768 : 0;
    let wet = dry;
    if (band) {
      high = highAlpha * (high + dry - previous); previous = dry;
      low += lowAlpha * (high - low); wet = Math.tanh(low * band[2]);
      if (config.filter === 'low_quality_phone') wet = Math.round(wet * 96) / 96;
    } else if (config.filter === 'robot') {
      const style = config.robotStyle;
      const frequency = {subtle: 42, metallic: 82, digital: 115, protocol_droid: 31, chorus: 2.2, johnny_five: 64}[style];
      const oscillator = Math.sin(2 * Math.PI * frequency * i / rate);
      if (style === 'chorus' || style === 'protocol_droid') {
        const delay = Math.round(rate * (0.014 + 0.003 * oscillator));
        const delayed = i >= delay && i - delay < count ? pcm.readInt16LE((i - delay) * 2) / 32768 : 0;
        wet = dry * 0.72 + delayed * 0.28;
      } else {
        const amount = style === 'subtle' ? 0.2 : 0.65;
        wet = dry * ((1 - amount) + amount * oscillator);
        if (style === 'digital') wet = Math.round(wet * 128) / 128;
        if (style === 'johnny_five') wet = Math.tanh(wet * 1.7) * 0.7;
      }
    }
    const space = room[config.space];
    if (space) {
      const a = Math.round(rate * space[0]), b = Math.round(rate * space[1]);
      wet += (i >= a ? history[i - a] * space[2] : 0) + (i >= b ? history[i - b] * space[2] * 0.6 : 0);
    }
    history[i] = wet;
    let value = (dry * (1 - config.wetMix) + wet * config.wetMix) * config.outputGain;
    // Fade only the synthetic tail; never gate or clip the source consonants.
    if (tail && i >= count) value *= Math.min(1, (count + tail - i - 1) / (rate * 0.025));
    value = Math.max(-0.95, Math.min(0.95, value));
    output.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  return output;
}
