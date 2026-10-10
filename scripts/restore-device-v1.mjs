// Revision 2. Restore dashboard contents and verify browser readiness; retain private user state.
import { readFile, cp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {validateBackup} from './device-backup.mjs';
import { fileURLToPath } from 'node:url';
const run=promisify(execFile);const root=fileURLToPath(new URL('../',import.meta.url));
if(process.platform!=='darwin')throw Error('Device restore requires macOS.');
const manifest=JSON.parse(await readFile(path.join(root,'.kitt-state/install-v1.json'),'utf8'));
validateBackup(manifest,root,os.homedir());
await run('/bin/launchctl',['bootout',`gui/${process.getuid()}/com.carthing.kitt`]).catch(()=>{});
await cp(path.join(manifest.backup,'host-device-ui'),path.join(manifest.collector,'device-ui'),{recursive:true});
const adb=process.env.KITT_ADB||'adb';
await run(adb,['-s',manifest.serial,'push',`${path.join(manifest.backup,'device-ui')}/.`,'/run/claudething-ui/'],{timeout:30000});
const result=await run(adb,['-s',manifest.serial,'shell','set -e; test -s /run/claudething-ui/index.html; rm -f /run/claudething-ui/kitt-v1.sha256; systemctl restart chromium-kiosk.service; for i in 1 2 3 4 5; do if systemctl is-active --quiet chromium-kiosk.service && wget -q -O /dev/null http://127.0.0.1:8080/; then echo KITT_RESTORED; exit 0; fi; sleep 1; done; exit 1'],{timeout:15000});
if(!result.stdout.includes('KITT_RESTORED'))throw new Error('The restored browser could not be verified.');
try {
  await cp(path.join(manifest.backup,'previous-kitt-agent.plist'),manifest.agent);
  await run('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,manifest.agent]);
} catch(error) {
  if(error.code!=='ENOENT')throw error;
  await rm(manifest.agent,{force:true});
}
console.log('Restored the original application dashboard. Reminders and backups were retained.');
