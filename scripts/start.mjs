import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {hostMode} from '../assistant/host-mode.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw Error('The private .env could not be loaded.'); }
if (process.platform !== 'darwin') throw Error('The assistant host requires macOS. Use npm run preview for the audio-reactive panel.');
hostMode();
const child = spawn(process.execPath, ['assistant/kitt-server-v1.mjs'], {cwd:root, stdio:'inherit', env:process.env});
child.on('error', () => { console.error('The host could not start.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));
