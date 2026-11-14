import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch (error) { if (error.code !== 'ENOENT') throw Error('The private configuration could not be read.'); }
const testing = process.argv[2] === '--test';
const command = process.env.KITT_LOCAL_TTS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const args = testing ? ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'local_voice_test.py'] : ['assistant/local-tts-v1.py', ...process.argv.slice(2)];
const child = spawn(command, args, {cwd: root, stdio: 'inherit'});
child.on('error', () => { console.error('The local voice Python runtime is unavailable. Set KITT_LOCAL_TTS_PYTHON to its executable.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
