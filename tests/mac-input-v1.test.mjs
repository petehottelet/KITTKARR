// Revision 2. Also verify denied microphone permission blocks wake and manual capture.
import {spawn} from 'node:child_process';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {MacInputMonitor,selectedMacInput} from '../assistant/mac-input-v1.mjs';
import {AudioEngine} from '../assistant/audio-v1.mjs';
import {createKittServer} from '../assistant/kitt-server-v1.mjs';

test('input monitor distinguishes the selected microphone from matching output devices',async()=>{
 const report=name=>({SPAudioDataType:[{_items:[{_name:'AirPods',coreaudio_default_audio_output_device:'spaudio_yes'},{_name:name,coreaudio_default_audio_input_device:'spaudio_yes',coreaudio_device_srate:24000}]}]});
 assert.equal(selectedMacInput(report('MacBook microphone')).name,'MacBook microphone');
 let value=report('AirPods'),fail=false;const changes=[];
 const monitor=new MacInputMonitor({read:async()=>{if(fail)throw Error('temporary');return value},onChange:async(input,previous)=>changes.push({input,previous})});
 await monitor.check();await monitor.check();assert.equal(changes.length,1);
 fail=true;await monitor.check();assert.equal(changes.length,1);
 fail=false;value=report('MacBook microphone');await monitor.check();assert.equal(changes[1].previous.name,'AirPods');
 value={};await monitor.check();assert.equal(changes[2].input,null);
 monitor.stop();value=report('AirPods');await monitor.check();assert.equal(changes.length,3);
});

test('denied Mac microphone permission keeps wake inactive and reports the correct manual error',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'kitt-input-permission-'));let starts=0;
 const wake={running:false,check:async()=>true,async start(){starts++;this.running=true},async stop(){this.running=false}};
 const inputMonitor={async start(){await this.onChange({name:'AirPods'},undefined)},stop(){}};
 const audio={initialize:async()=>{},check:async()=>({transcription:true,microphoneSource:'mac',microphonePermission:'denied'}),stopPlayback(){},startCapture:async()=>{starts++},stopCapture:async()=>null,close:async()=>{}};
 const assistant={sources:[],initialize:async()=>[],cancel:async()=>{},close(){}};
 const app=await createKittServer({port:0,directory:dir,audio,assistant,wake,inputMonitor,bridge:{start(){this.onChange({connected:true})},stop(){}}});
 try{
  await app.start();const base=`http://127.0.0.1:${app.port}`;const post=(route,body={})=>fetch(base+'/api/'+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-KITT-Intent':'1'},body:JSON.stringify(body)});
  await post('wake',{clientId:'test-screen',active:true});await new Promise(r=>setTimeout(r,400));
  assert.equal(app.state().audio.microphoneAvailable,false);assert.equal(starts,0);
  const response=await post('listen/start');assert.equal(response.status,400);assert.match((await response.json()).error,/microphone access/);
  await inputMonitor.onChange({name:'MacBook microphone'},{name:'AirPods'});assert.match(app.state().status,/microphone access/);assert.equal(starts,0);
 }finally{await app.close();await rm(dir,{recursive:true,force:true})}
});

test('Mac recording waits for PCM, returns mono samples and cancels pending startup',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'kitt-mac-input-'));const old=process.env.KITT_INPUT_SOURCE;process.env.KITT_INPUT_SOURCE='mac';
 const fake=path.join(dir,'fake-ffmpeg-v1');
 const audio=new AudioEngine({directory:dir});audio.ffmpeg=fake;audio.spawnProcess=(command,args,options)=>spawn(process.execPath,[command],options);
 try{
  await writeFile(fake,`#!/usr/bin/env node\n// Revision 1. Synthetic PCM capture fixture.\nconst b=Buffer.alloc(32000);for(let i=0;i<b.length;i+=2)b.writeInt16LE(1200,i);setTimeout(()=>process.stdout.write(b),100);setInterval(()=>{},1000);process.on('SIGINT',()=>process.exit(0));\n`,{mode:0o700});
  await audio.startCapture();assert(audio.capture.bytes>=32000);const pcm=await audio.stopCapture();assert.equal(pcm.length,32000);assert.equal(pcm.readInt16LE(0),1200);assert.equal(audio.capture,null);
  await writeFile(fake,`#!/usr/bin/env node\n// Revision 2. Pending startup capture fixture.\nsetInterval(()=>{},1000);process.on('SIGINT',()=>process.exit(0));\n`,{mode:0o700});
  const start=audio.startCapture();const rejected=assert.rejects(start,/stopped/);await new Promise(r=>setTimeout(r,100));await audio.stopCapture(true);await rejected;assert.equal(audio.capture,null);
 }finally{await audio.close();if(old===undefined)delete process.env.KITT_INPUT_SOURCE;else process.env.KITT_INPUT_SOURCE=old;await rm(dir,{recursive:true,force:true})}
});

test('switching Mac input restarts idle wake capture and safely discards an in-flight recording',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'kitt-input-switch-'));let starts=0,discards=0;
 const wake={running:false,check:async()=>true,async start(){starts++;this.running=true;this.onState(true)},async stop(){this.running=false;this.onState(false)}};
 const inputMonitor={async start(){await this.onChange({name:'AirPods'},undefined)},stop(){}};
 const audio={initialize:async()=>{},check:async()=>({transcription:true,microphoneSource:'mac'}),stopPlayback(){},startCapture:async()=>{},stopCapture:async discard=>{if(discard)discards++;return null},close:async()=>{}};
 const assistant={sources:[],initialize:async()=>[],cancel:async()=>{},close(){}};
 const app=await createKittServer({port:0,directory:dir,audio,assistant,wake,inputMonitor,bridge:{start(){this.onChange({connected:true})},stop(){}}});
 const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,25))}assert.fail('Microphone handoff did not settle')};
 try{
  await app.start();const base=`http://127.0.0.1:${app.port}`;const post=(route,body={})=>fetch(base+'/api/'+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-KITT-Intent':'1'},body:JSON.stringify(body)});
  await post('wake',{clientId:'test-screen',active:true});await until(()=>wake.running);assert.equal(app.state().audio.microphone,'AirPods');
  await inputMonitor.onChange({name:'MacBook microphone'},{name:'AirPods'});await until(()=>starts===2&&wake.running);assert.equal(app.state().audio.microphone,'MacBook microphone');
  assert.equal((await post('listen/start')).status,200);assert.equal(app.state().phase,'listening');const before=discards;
  await inputMonitor.onChange({name:'AirPods'},{name:'MacBook microphone'});assert.equal(app.state().phase,'idle');assert.equal(discards,before+1);
  await inputMonitor.onChange(null,{name:'AirPods'});assert.equal(wake.running,false);assert.equal((await post('listen/start')).status,400);
 }finally{await app.close();await rm(dir,{recursive:true,force:true})}
});
