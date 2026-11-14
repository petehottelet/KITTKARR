import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {readConfiguration} from './setup-config.mjs';
import {diagnoseSidePulse, previewSidePulse} from '../assistant/sidepulse-v1.mjs';

export async function testLeds(env, {request = fetch, probe = diagnoseSidePulse, preview = previewSidePulse} = {}) {
  if (env.KITT_SIDEPULSE !== '1') throw Error('Choose SidePulse or both in npm run setup first.');
  const port = Number(env.KITT_PORT || 4180);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('KITT_PORT must be a valid port number.');
  const origin = `http://127.0.0.1:${port}`;
  let response;
  try {
    response = await request(origin + '/api/sidepulse/test', {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json', 'X-KITT-Intent': '1'}, body: '{}', signal: AbortSignal.timeout(5000), redirect: 'error'});
  } catch (error) {
    if (error?.cause?.code !== 'ECONNREFUSED' && error?.code !== 'ECONNREFUSED') throw Error('The host did not answer. Stop the current request and try again.');
    const status = await probe();
    if (!status.ready) throw Error(status.message);
    try { await preview(); } catch { throw Error('The LED test could not complete. Run npm run doctor, then try again.'); }
    return;
  }
  if (!response.ok) throw Error('The host could not test the LEDs. Stop any active reply, restart after setup changes, and run npm run doctor.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {env} = await readConfiguration(fileURLToPath(new URL('../', import.meta.url)), process.env);
    await testLeds(env);
    console.log('LED test sent. Look for a short red sweep; the preceding display is restored afterward.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
