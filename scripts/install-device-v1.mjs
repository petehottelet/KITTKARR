// Revision 7. Install the native audio-clock player for synchronized LED playback.
import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { mkdir, cp, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {installHost,buildHostHelpers} from './host-service.mjs';
const run=promisify(execFile);const root=fileURLToPath(new URL('../',import.meta.url));
const state=path.join(root,'.kitt-state');const collector=path.join(os.homedir(),'Library/Application Support/CarThingCollector');
const agent=path.join(os.homedir(),'Library/LaunchAgents/com.carthing.kitt.plist');
if(process.platform!=='darwin')throw Error('Device installation requires macOS.');
const alreadyInstalled=await access(path.join(state,'install-v1.json')).then(()=>true,()=>false);
if(alreadyInstalled)throw Error('The Car Thing dashboard is already installed. Use npm run host:install to apply hardware settings, or device:restore before reinstalling the dashboard.');

const dist=path.join(root,'dashboard-v1/apps/device-ui/dist');
const config={...parseEnv(await readFile(path.join(root,'.env'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error})),...process.env};
const adb=config.KITT_ADB||'adb',serial=config.KITT_ADB_SERIAL||'';
if(!/^[a-zA-Z0-9._:-]+$/.test(serial))throw Error('Set KITT_ADB_SERIAL in .env before installing.');
if(config.KITT_MODE!=='carthing')throw Error('Run npm run setup and choose Car Thing or both before installing.');
const previousAgent=await readFile(agent,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error});
const escapedRoot=root.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
if(previousAgent&&!previousAgent.includes(`<key>WorkingDirectory</key><string>${escapedRoot}</string>`))throw Error('A KITT service from another installation already exists. Remove it there first.');
await access(path.join(dist,'index.html'));await access(path.join(root,'device-v1.html'));await access(path.join(collector,'device-ui/index.html'));
const identity=await run(adb,['-s',serial,'shell',"grep -qx 'ID=claudething' /etc/os-release && echo KITT_DEVICE_OK"],{timeout:5000});
if(!identity.stdout.includes('KITT_DEVICE_OK'))throw new Error('This is not the expected ClaudeThing firmware.');
await buildHostHelpers({root,run});
await mkdir(state,{recursive:true,mode:0o700});
const backup=path.join(state,'backups',new Date().toISOString().replaceAll(':','-'));await mkdir(backup,{recursive:true,mode:0o700});
await cp(path.join(collector,'device-ui'),path.join(backup,'host-device-ui'),{recursive:true});
await run(adb,['-s',serial,'pull','/run/claudething-ui',path.join(backup,'device-ui')],{timeout:20000,maxBuffer:1024*1024});
try{await cp(agent,path.join(backup,'previous-kitt-agent.plist'))}catch(error){if(error.code!=='ENOENT')throw error}
try{await cp(path.join(state,'host-service.json'),path.join(backup,'previous-host-service.json'))}catch(error){if(error.code!=='ENOENT')throw error}
// Preserve the existing pairing/time-zone runtime config and collector service.
await cp(path.join(dist,'assets'),path.join(collector,'device-ui/assets'),{recursive:true});
await cp(path.join(dist,'index.html'),path.join(collector,'device-ui/index.html'));
await writeFile(path.join(state,'install-v1.json'),JSON.stringify({version:1,installedAt:new Date().toISOString(),backup,collector,serial,agent},null,2),{mode:0o600});
await installHost({root,env:config,deploy:true,build:false});
console.log('Installed K.I.T.T. host service. Reversible UI backup: '+backup);
console.log('The host will apply the dashboard menu and preset 3 integration over ADB.');
