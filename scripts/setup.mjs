import {createInterface} from 'node:readline/promises';
import {stdin, stdout} from 'node:process';
import {execFile} from 'node:child_process';
import {promisify, parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {access} from 'node:fs/promises';
import {readConfiguration, saveHardware, selectedHardware, hardwareChoices} from './setup-config.mjs';
import {findCarThings, checkHardware} from './hardware-check.mjs';
import {installHost} from './host-service.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
export async function runSetup({directory = root, platform = process.platform, question, log = console.log, choice, install = true,
  discover = findCarThings, check = checkHardware, register = installHost, execute = run} = {}) {
  if (platform !== 'darwin') throw Error('The assistant host requires macOS. npm run preview works on other platforms.');
  const prior = (await readConfiguration(directory)).env;
  const keys = ['carthing', 'sidepulse', 'both', 'browser'];
  if (!choice) {
    log('Connect your hardware. Car Thing, SidePulse and both use the same KITT host.');
    const fallback = String(keys.indexOf(selectedHardware(prior)) + 1);
    const answer = (await question(`Use [1] Car Thing, [2] SidePulse, [3] both, or [4] Mac browser only? [${fallback}]: `)).trim() || fallback;
    choice = keys[Number(answer) - 1];
  }
  if (!hardwareChoices[choice]) throw Error('Choose 1, 2, 3 or 4, or use --hardware carthing|sidepulse|both|browser.');
  let serial = prior.KITT_ADB_SERIAL || '';
  if (hardwareChoices[choice].mode === 'carthing') {
    const devices = await discover({env: {...process.env, ...prior}});
    if (devices.length === 1) serial = devices[0];
    else if (!devices.includes(serial)) {
      log('Multiple compatible Car Things found. Use adb devices to identify the one to use.');
      serial = (await question('Enter its serial (saved privately): ')).trim();
      if (!devices.includes(serial)) throw Error('That Car Thing is not connected.');
    }
  }
  const env = await saveHardware(directory, choice, serial);
  log(`Saved: ${hardwareChoices[choice].label}. Existing voice, chat and account settings were preserved.`);
  const checks = await check({env: {...process.env, ...env}});
  for (const item of checks) log(`${item.ok ? 'OK' : 'SETUP'} — ${item.name}: ${item.message}`);
  if (env.KITT_SIDEPULSE === '1') log('SidePulse Pro with a mounted drive is supported. Official companion installation: https://github.com/inteliwear/sidepulse#installation');
  if (!checks.some(item => !item.ok && item.name !== 'SidePulse') && install) {
    const prompt = env.KITT_MODE === 'carthing' ? 'Install the Car Thing dashboard and start KITT at login? [y/N]: ' : 'Start KITT now and automatically at login? [y/N]: ';
    if (/^y(?:es)?$/i.test((await question(prompt)).trim())) {
      const deviceInstalled = await access(path.join(directory, '.kitt-state/install-v1.json')).then(() => true, () => false);
      if (env.KITT_MODE === 'carthing' && !deviceInstalled) {
        log('Building the dashboard and installing its backed-up integration…');
        try {
          const childEnv = {...process.env, ...env};
          await execute(process.execPath, [path.join(directory, 'scripts/build-device-v1.mjs')], {cwd: directory, env: childEnv, timeout: 30000});
          await execute(process.execPath, [path.join(directory, 'node_modules/typescript/bin/tsc'), '--noEmit'], {cwd: path.join(directory, 'dashboard-v1/apps/device-ui'), env: childEnv, timeout: 120000});
          await execute(process.execPath, [path.join(directory, 'node_modules/vite/bin/vite.js'), 'build'], {cwd: path.join(directory, 'dashboard-v1/apps/device-ui'), env: childEnv, timeout: 120000});
          await execute(process.execPath, [path.join(directory, 'scripts/install-device-v1.mjs')], {cwd: directory, env: childEnv, timeout: 300000});
        } catch { throw Error('Car Thing installation could not finish. Run npm run doctor, then npm run device:install for guidance. Private backups were retained.'); }
      } else { log('Building the Mac helpers and registering KITT…'); await register({root: directory, env}); }
      log('KITT is installed. Allow microphone access if prompted.');
    } else log('Start KITT when ready: npm start. If it is already running, restart it to apply hardware changes (host:install for the login service).');
  } else log('Finish any SETUP items above, then run npm start. Run npm run doctor to check again.');
  log(`Open http://127.0.0.1:${env.KITT_PORT || 4180} → Details → Settings. Test voice uses your selected voice; the default Mac voice needs no account.`);
  if (env.KITT_SIDEPULSE === '1') log('Use Test LEDs there, or run npm run leds:test. No microphone or AI service is needed for the LED test.');
  log('General conversation and microphone transcription are optional next steps in docs/SETUP.md. Run setup again whenever your hardware changes.');
  return {env, checks};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let prompt;
  try {
    const {values} = parseArgs({options: {hardware: {type: 'string'}, 'no-install': {type: 'boolean'}, help: {type: 'boolean'}}});
    if (values.help) console.log('npm run setup\nnpm run setup -- --hardware carthing|sidepulse|both|browser --no-install\nUpdates only hardware settings; existing provider configuration is retained.');
    else {
      prompt = createInterface({input: stdin, output: stdout});
      await runSetup({choice: values.hardware, install: !values['no-install'], question: text => prompt.question(text)});
    }
  } catch (error) { console.error(error.code ? 'Setup could not access its files. Check the project folder and try again.' : error.message); process.exitCode = 1; }
  finally { prompt?.close(); }
}
