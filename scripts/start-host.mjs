import path from 'node:path';
import os from 'node:os';
import {readFile} from 'node:fs/promises';
import {startInstalledHost} from '../assistant/host-autostart.mjs';

export async function existingHost(root, env, {request = fetch, home = os.homedir(), read = readFile, start = startInstalledHost, wait = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  const port = Number(env.KITT_PORT || 4180);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('KITT_PORT must be a valid port number.');
  const url = `http://127.0.0.1:${port}`;
  const probe = async () => {
    let response;
    try { response = await request(url + '/api/state', {signal: AbortSignal.timeout(1500), redirect: 'error'}); }
    catch (error) {
      if (error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED') return false;
      throw Error('The local host is not responding. Check npm run doctor and the existing host before starting another.');
    }
    let state; try { state = response.ok ? await response.json() : null; } catch { /* Not a compatible host. */ }
    if (state?.version !== 1 || !state.hardware) throw Error('This port is occupied by another service or an older KITT host. Stop it before starting KITT.');
    if (state.hardware.carThing !== (env.KITT_MODE === 'carthing') || state.hardware.sidePulse !== (env.KITT_SIDEPULSE === '1')) throw Error('Hardware settings changed. Restart the running host: use npm run host:install for the login service, or stop its Terminal and run npm start again.');
    return true;
  };
  if (await probe()) return url;
  const file = path.join(home, 'Library/LaunchAgents/com.carthing.kitt.plist');
  let plist;
  try { plist = await read(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw Error('The installed host configuration could not be read.'); }
  const encoded = root.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
  if (!plist.includes(`<key>WorkingDirectory</key><string>${encoded}</string>`)) throw Error('A KITT service from another installation exists. Start or remove it from that installation first.');
  await start();
  for (let i = 0; i < 40; i++) { await wait(500); if (await probe()) return url; }
  throw Error('KITT is starting. Allow its microphone prompt, then try npm start again. Check the login service if it remains unavailable.');
}
