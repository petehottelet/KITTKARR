// Revision 7. Install the native audio-clock player for synchronized LED playback.
import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { mkdir, cp, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const run=promisify(execFile);const root=fileURLToPath(new URL('../',import.meta.url));
const state=path.join(root,'.kitt-state');const collector=path.join(os.homedir(),'Library/Application Support/CarThingCollector');
const agent=path.join(os.homedir(),'Library/LaunchAgents/com.carthing.kitt.plist');
if(process.platform!=='darwin')throw Error('Device installation requires macOS.');

const dist=path.join(root,'dashboard-v1/apps/device-ui/dist');
const config={...parseEnv(await readFile(path.join(root,'.env'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error})),...process.env};
const adb=config.KITT_ADB||'adb',serial=config.KITT_ADB_SERIAL||'';
if(!/^[a-zA-Z0-9._:-]+$/.test(serial))throw Error('Set KITT_ADB_SERIAL in .env before installing.');
let hostArguments=[process.execPath,path.join(root,'assistant/kitt-server-v1.mjs')];
if(process.platform==='darwin')await run(process.execPath,[path.join(root,'scripts/build-mac-player-v1.mjs')],{timeout:120000});
if(process.platform==='darwin'&&['mac','computer','auto'].includes(config.KITT_INPUT_SOURCE)){
  await run(process.execPath,[path.join(root,'scripts/build-mac-host-v1.mjs')],{timeout:120000});
  hostArguments=[path.join(state,'KITT.app/Contents/MacOS/KITT')];
}
await access(path.join(dist,'index.html'));await access(path.join(root,'device-v1.html'));await access(path.join(collector,'device-ui/index.html'));
const identity=await run(adb,['-s',serial,'shell',"grep -qx 'ID=claudething' /etc/os-release && echo KITT_DEVICE_OK"],{timeout:5000});
if(!identity.stdout.includes('KITT_DEVICE_OK'))throw new Error('This is not the expected ClaudeThing firmware.');
await mkdir(state,{recursive:true,mode:0o700});
const backup=path.join(state,'backups',new Date().toISOString().replaceAll(':','-'));await mkdir(backup,{recursive:true,mode:0o700});
await cp(path.join(collector,'device-ui'),path.join(backup,'host-device-ui'),{recursive:true});
await run(adb,['-s',serial,'pull','/run/claudething-ui',path.join(backup,'device-ui')],{timeout:20000,maxBuffer:1024*1024});
try{await cp(agent,path.join(backup,'previous-kitt-agent.plist'))}catch(error){if(error.code!=='ENOENT')throw error}
// Preserve the existing pairing/time-zone runtime config and collector service.
await cp(path.join(dist,'assets'),path.join(collector,'device-ui/assets'),{recursive:true});
await cp(path.join(dist,'index.html'),path.join(collector,'device-ui/index.html'));
const xml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const plist=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>com.carthing.kitt</string><key>ProgramArguments</key><array>${hostArguments.map(argument=>`<string>${xml(argument)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict><key>KITT_MODE</key><string>carthing</string><key>KITT_DEPLOY_UI</key><string>1</string><key>KITT_STATE_DIR</key><string>${xml(state)}</string><key>KITT_ADB_SERIAL</key><string>${xml(serial)}</string><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
<key>ProcessType</key><string>Interactive</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(path.join(state,'host.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(state,'host-error.log'))}</string></dict></plist>`;
await mkdir(path.dirname(agent),{recursive:true});await writeFile(agent,plist,{mode:0o600});
await writeFile(path.join(state,'install-v1.json'),JSON.stringify({version:1,installedAt:new Date().toISOString(),backup,collector,serial,agent},null,2),{mode:0o600});
await run('/bin/launchctl',['bootout',`gui/${process.getuid()}/com.carthing.kitt`]).catch(()=>{});
for(let attempt=0;;attempt++){
  try{await run('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,agent]);break}
  catch(error){if(attempt>=3)throw error;await new Promise(resolve=>setTimeout(resolve,1000))}
}
console.log('Installed K.I.T.T. host service. Reversible UI backup: '+backup);
console.log('The host will apply the dashboard menu and preset 3 integration over ADB.');
