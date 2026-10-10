import {createInterface} from 'node:readline/promises';
import {stdin, stdout} from 'node:process';
import {writeFile, access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
if (process.platform !== 'darwin') throw Error('The assistant host requires macOS. npm run preview works on other platforms.');
try { await access('.env'); console.log('Existing .env preserved. Edit it to change settings; see docs/SETUP.md.'); process.exit(0); } catch {}
try { await run('ffmpeg', ['-version']); } catch { throw Error('Install FFmpeg first: brew install ffmpeg'); }
const prompt = createInterface({input:stdin, output:stdout});
try {
  const choice = (await prompt.question('Run on [1] Mac browser or [2] USB Car Thing? [1]: ')).trim() || '1';
  if (!['1','2'].includes(choice)) throw Error('Choose 1 or 2.');
  let serial = '';
  if (choice === '2') {
    let result;
    try { result = await run('adb', ['devices']); } catch { throw Error('Install Android platform tools and connect the device first. See docs/CARTHING.md.'); }
    const devices = result.stdout.split(/\r?\n/).filter(line => /\tdevice$/.test(line)).map(line => line.split('\t')[0]);
    if (!devices.length) throw Error('No authorized ADB device found. See docs/CARTHING.md.');
    if (devices.length === 1) serial = devices[0];
    else {
      console.log('Multiple devices found. Run adb devices in another terminal to identify yours.');
      serial = (await prompt.question('Device serial: ')).trim();
      if (!devices.includes(serial)) throw Error('The selected device is not connected.');
    }
  }
  const config = [
    `KITT_MODE=${choice === '2' ? 'carthing' : 'browser'}`, 'KITT_BRAIN=chat',
    `KITT_INPUT_SOURCE=${choice === '2' ? 'auto' : 'mac'}`, `KITT_ADB_SERIAL=${serial}`,
    'TTS_PROVIDER=system', 'TTS_ENDPOINT=', 'TTS_API_KEY=', 'TTS_MODEL=', 'TTS_VOICE=',
    'CHAT_ENDPOINT=', 'CHAT_MODEL=', 'CHAT_API_KEY=',
    'KITT_TRANSCRIPTION_PROVIDER=local', 'KITT_WHISPER_MODEL=',
    '# Optional cloud transcription: set provider=openai and supply your own key/model.',
    'OPENAI_API_KEY=', 'OPENAI_TRANSCRIPTION_MODEL=',
    '# Wake-word listening is optional. Typed requests and voice tests work without it.',
    'KITT_TIMEZONE=', ''
  ].join('\n');
  await writeFile('.env', config, {flag:'wx', mode:0o600});
  console.log('Private configuration created. No cloud service is enabled.');
  console.log('Run npm start, then open http://127.0.0.1:4180. See docs/SETUP.md for conversation and microphone input.');
  if (choice === '2') console.log('Before installing the dashboard, follow docs/CARTHING.md.');
} finally { prompt.close(); }
