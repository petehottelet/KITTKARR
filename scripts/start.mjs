import {spawn, execFile} from 'node:child_process';
import {access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {hostMode} from '../assistant/host-mode.mjs';
import {existingHost} from './start-host.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw Error('The private .env could not be loaded.'); }
if (process.platform !== 'darwin') throw Error('The assistant host requires macOS. Use npm run preview for the audio-reactive panel.');
try {
  hostMode();
  const url = `http://127.0.0.1:${Number(process.env.KITT_PORT || 4180)}`;
  const open = () => { if (process.env.KITT_OPEN_BROWSER !== '0') execFile('/usr/bin/open', [url], () => {}); };
  if (await existingHost(root, process.env)) { console.log(`KITT is already running at ${url}`); open(); }
  else {
    const native = '.kitt-state/KITT.app/Contents/MacOS/KITT';
    const built = await access(native).then(() => true, () => false);
    const child = spawn(built ? native : process.execPath, built ? [] : ['assistant/kitt-server-v1.mjs'], {cwd:root, stdio:['inherit','pipe','inherit'], env:process.env});
    let opened = false;
    child.stdout.on('data', data => { process.stdout.write(data); if (!opened && data.toString().includes('is ready at')) { opened = true; open(); } });
    child.on('error', () => { console.error('The host could not start.'); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => child.kill(built ? 'SIGTERM' : signal));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
