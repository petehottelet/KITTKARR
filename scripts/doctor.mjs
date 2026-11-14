import {fileURLToPath} from 'node:url';
import {readConfiguration, selectedHardware, hardwareChoices} from './setup-config.mjs';
import {checkHardware} from './hardware-check.mjs';

try {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const {env} = await readConfiguration(root, process.env);
  console.log(`Hardware: ${hardwareChoices[selectedHardware(env)].label}`);
  const checks = await checkHardware({env});
  for (const check of checks) console.log(`${check.ok ? 'OK' : 'SETUP'} — ${check.name}: ${check.message}`);
  console.log('TRY — Open Details → Settings and use Test voice. System speech needs no AI account.');
  if (!env.CHAT_ENDPOINT && (!env.KITT_BRAIN || env.KITT_BRAIN === 'chat')) console.log('OPTIONAL — General conversation needs a chat service. See docs/SETUP.md.');
  console.log('OPTIONAL — Microphone transcription and wake words have separate setup. See docs/SETUP.md.');
  if (checks.some(check => !check.ok)) process.exitCode = 1;
} catch { console.error('The hardware check could not finish. Check the private configuration, then try again.'); process.exitCode = 1; }
