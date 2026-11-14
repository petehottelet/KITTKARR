import {readFile, appendFile, lstat} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import path from 'node:path';

export const hardwareChoices = Object.freeze({
  carthing: {label: 'Car Thing', mode: 'carthing', leds: false},
  sidepulse: {label: 'SidePulse', mode: 'browser', leds: true},
  both: {label: 'Car Thing + SidePulse', mode: 'carthing', leds: true},
  browser: {label: 'Mac browser only', mode: 'browser', leds: false}
});

export function selectedHardware(env = {}) {
  return env.KITT_MODE === 'carthing' ? (env.KITT_SIDEPULSE === '1' ? 'both' : 'carthing') : (env.KITT_SIDEPULSE === '1' ? 'sidepulse' : 'browser');
}

export async function readConfiguration(root, overrides = {}) {
  let source = '';
  try { source = await readFile(path.join(root, '.env'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw Error('The private configuration could not be read.'); }
  return {source, env: {...parseEnv(source), ...overrides}};
}

export async function saveHardware(root, choice, serial = '') {
  const selected = hardwareChoices[choice];
  if (!selected) throw Error('Choose Car Thing, SidePulse, both, or Mac browser.');
  if (selected.mode === 'carthing' && !/^[a-zA-Z0-9._:-]+$/.test(serial)) throw Error('Select an authorized Car Thing.');
  const filename = path.join(root, '.env');
  try { if (!(await lstat(filename)).isFile()) throw Error('Use a regular private .env file.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const {source, env} = await readConfiguration(root);
  const hardware = {KITT_MODE: selected.mode, KITT_SIDEPULSE: selected.leds ? '1' : '0', KITT_ADB_SERIAL: selected.mode === 'carthing' ? serial : ''};
  if (selectedHardware(env) !== choice || !env.KITT_INPUT_SOURCE) hardware.KITT_INPUT_SOURCE = selected.mode === 'carthing' ? 'auto' : 'mac';
  const defaults = {KITT_BRAIN: 'chat', TTS_PROVIDER: 'system', TTS_ENDPOINT: '', TTS_API_KEY: '', TTS_MODEL: '', TTS_VOICE: '', CHAT_ENDPOINT: '', CHAT_MODEL: '', CHAT_API_KEY: '', KITT_TRANSCRIPTION_PROVIDER: 'local', KITT_WHISPER_MODEL: '', OPENAI_API_KEY: '', OPENAI_TRANSCRIPTION_MODEL: '', KITT_TIMEZONE: ''};
  const additions = Object.entries({...Object.fromEntries(Object.entries(defaults).filter(([key]) => !Object.hasOwn(env, key))), ...hardware}).filter(([key, value]) => env[key] !== value);
  if (additions.length) {
    // Append only changed owned settings. Node's dotenv parser uses the last assignment;
    // existing keys, comments and multiline provider settings remain byte-for-byte intact.
    await appendFile(filename, `${source && !source.endsWith('\n') ? '\n' : ''}\n# Hardware setup\n${additions.map(([key, value]) => `${key}=${value}`).join('\n')}\n`, {mode: 0o600});
  }
  return (await readConfiguration(root)).env;
}
