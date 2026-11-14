import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startInstalledHost} from '../assistant/host-autostart.mjs';

export async function controlHeadless(command = 'status', {port = 4180, fetch: request = fetch, startHost = startInstalledHost, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), startupAttempts = 40} = {}) {
  if (!['status', 'run', 'start', 'resume', 'pause', 'stop'].includes(command)) throw Error('Use run, pause, resume, stop, or status.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('KITT_PORT must be a valid port number.');
  const base = `http://127.0.0.1:${port}`;
  const send = async (route, body) => {
    let response;
    try {
      response = await request(base + '/api/' + route, {
        signal: AbortSignal.timeout(20000), redirect: 'error',
        ...(body === undefined ? {} : {method: 'POST', headers: {Origin: base, 'Content-Type': 'application/json', 'X-KITT-Intent': '1'}, body: JSON.stringify(body)})
      });
    } catch (cause) {
      const error = Error('The KITT host is unavailable. Start it with npm start on your Mac, then try again.');
      error.offline = cause?.cause?.code === 'ECONNREFUSED' || cause?.code === 'ECONNREFUSED';
      throw error;
    }
    if (!response.ok) throw Error('The KITT host rejected the command. Check its status and try again.');
    try { return await response.json(); } catch { throw Error('The KITT host returned an unreadable response.'); }
  };
  let state;
  try { state = await send('state'); }
  catch (error) {
    if (!error.offline || !['run', 'start', 'resume'].includes(command)) throw error;
    await startHost();
    for (let attempt = 0; attempt < startupAttempts; attempt++) {
      await sleep(500);
      try { state = await send('state'); break; }
      catch (retry) { if (!retry.offline) throw retry; }
    }
    if (!state) throw Error('The KITT host did not become ready. Check its Mac service configuration and port.');
  }
  if (command === 'status') return state;
  if (command === 'pause' && !state.headless?.enabled) throw Error('Headless mode is stopped. Use run first.');
  await send('headless', {enabled: command !== 'stop', paused: command === 'pause'});
  return send('state');
}

export function formatHeadlessStatus(state) {
  const mode = !state.headless?.enabled ? 'stopped' : state.headless.paused ? 'paused' : state.wake?.active ? 'listening' : state.phase;
  return [
    `KITT headless: ${mode || 'starting'}`,
    `Wake listening: ${state.wake?.active ? 'active' : state.wake?.available ? 'inactive' : 'needs setup'}`,
    `SidePulse: ${state.sidePulse?.mode || 'unavailable'}`
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2] || 'status';
    if (['help', '--help', '-h'].includes(command)) {
      console.log('npm run headless -- run     Start a Mac microphone session\nnpm run headless -- pause   Release the microphone and darken SidePulse\nnpm run headless -- resume  Resume the session\nnpm run headless -- stop    End the session and release SidePulse\nnpm run headless -- status  Show session and LED status\n\nRun/resume can start an installed Mac host service. Otherwise use npm start first. Use KITT_SIDEPULSE=1 to enable LED control.');
    } else {
      try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch (error) { if (error.code !== 'ENOENT') throw Error('The private configuration could not be read.'); }
      const state = await controlHeadless(command, {port: Number(process.env.KITT_PORT || 4180)});
      console.log(formatHeadlessStatus(state));
      if (state.headless?.enabled && !state.headless.paused && !state.wake?.available) {
        console.error('Wake listening needs setup. See docs/OPTIONAL.md, then restart the host.');
        process.exitCode = 1;
      }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
