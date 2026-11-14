import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {diagnoseSidePulse} from '../assistant/sidepulse-v1.mjs';

const exec = promisify(execFile);
export async function findCarThings({env = process.env, run = exec} = {}) {
  let output;
  try { output = (await run(env.KITT_ADB || 'adb', ['devices'], {timeout: 5000})).stdout; }
  catch { throw Error('Install Android platform tools, then reconnect: brew install --cask android-platform-tools'); }
  const devices = output.split(/\r?\n/).filter(line => /\tdevice\s*$/.test(line)).map(line => line.split('\t')[0]).filter(serial => /^[a-zA-Z0-9._:-]+$/.test(serial));
  if (!devices.length) throw Error('No authorized Car Thing found. Use a data-capable USB cable and authorize ADB.');
  const compatible = [];
  for (const serial of devices) {
    try {
      const result = await run(env.KITT_ADB || 'adb', ['-s', serial, 'shell', "grep -qx 'ID=claudething' /etc/os-release && echo KITT_DEVICE_OK"], {timeout: 5000});
      if (result.stdout.includes('KITT_DEVICE_OK')) compatible.push(serial);
    } catch { /* Other ADB devices are not Car Things. */ }
  }
  if (!compatible.length) throw Error('Install compatible ClaudeThing firmware first. Stock Car Thing firmware is not supported; see docs/CARTHING.md.');
  return compatible;
}

export async function checkHardware({env = process.env, run = exec, home = os.homedir(), exists = access, sidePulse = diagnoseSidePulse} = {}) {
  const checks = [];
  try { await run(env.KITT_FFMPEG || 'ffmpeg', ['-version'], {timeout: 5000}); checks.push({name: 'Mac audio', ok: true, message: 'FFmpeg is available.'}); }
  catch { checks.push({name: 'Mac audio', ok: false, message: 'Install FFmpeg: brew install ffmpeg'}); }
  if (env.KITT_MODE === 'carthing') {
    try {
      const devices = await findCarThings({env, run});
      if (!devices.includes(env.KITT_ADB_SERIAL)) throw Error('The selected Car Thing is disconnected. Reconnect it or run npm run setup to choose another.');
      await exists(path.join(home, 'Library/Application Support/CarThingCollector/device-ui/index.html')).catch(() => { throw Error('Install the compatible Mac collector first; see docs/CARTHING.md.'); });
      checks.push({name: 'Car Thing', ok: true, message: 'Compatible device and Mac collector detected.'});
    } catch (error) { checks.push({name: 'Car Thing', ok: false, message: error.message}); }
  }
  if (env.KITT_SIDEPULSE === '1') {
    const status = await sidePulse();
    checks.push({name: 'SidePulse', ok: status.ready, message: status.message});
  }
  return checks;
}
