// Revision 4. Verify computer-only capture ignores a selected AirPods input.
import {spawn} from 'node:child_process';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {microphoneCandidates,PcmHealth,PcmCapture,MicrophoneRouter,carThingInput} from '../assistant/microphone-v1.mjs';
import {AudioEngine} from '../assistant/audio-v1.mjs';
const report={SPAudioDataType:[{_items:[
  {_name:'AirPods',coreaudio_device_input:1,coreaudio_default_audio_input_device:'spaudio_yes',coreaudio_device_transport:'coreaudio_device_type_bluetooth'},
  {_name:'MacBook microphone',coreaudio_device_input:1,coreaudio_device_transport:'coreaudio_device_type_builtin'},
  {_name:'AirPods',coreaudio_device_output:2}
]}]};
const pcm=()=>{const b=Buffer.alloc(6400);for(let i=0;i<b.length;i+=2)b.writeInt16LE(i%4===0?200:-200,i);return b};

test('automatic priority is Car Thing, built-in Mac, then AirPods',()=>{
 assert.deepEqual(microphoneCandidates(report).map(r=>r.name),['Car Thing microphone','MacBook microphone','AirPods']);
 const two={SPAudioDataType:[{_items:[{_name:'AirPods Pro',coreaudio_device_input:1,coreaudio_device_transport:'coreaudio_device_type_bluetooth'},...report.SPAudioDataType[0]._items]}]};
 assert.deepEqual(microphoneCandidates(two).map(r=>r.name),['Car Thing microphone','MacBook microphone','AirPods','AirPods Pro']);
 assert.deepEqual(microphoneCandidates({SPAudioDataType:[{_items:[report.SPAudioDataType[0]._items[1]]}]}).map(r=>r.name),['Car Thing microphone','MacBook microphone']);
 assert.deepEqual(microphoneCandidates(report,'auto',false),[carThingInput]);
 assert.deepEqual(microphoneCandidates(report,'mac').map(r=>r.name),['AirPods']);
 assert.deepEqual(microphoneCandidates(report,'computer').map(r=>r.name),['MacBook microphone']);
 assert.deepEqual(microphoneCandidates(report,'computer',false),[]);
});

test('health requires real changing samples, accepts quiet audio, and rejects frozen streams',()=>{
 const silent=new PcmHealth();silent.add(Buffer.alloc(96000));assert.equal(silent.ready,false);assert.equal(silent.unusable,true);
 const quiet=new PcmHealth(),data=pcm();for(let i=0;i<data.length;i+=2)data.writeInt16LE(i%4===0?1:-1,i);quiet.add(data);assert.equal(quiet.ready,true);assert.equal(quiet.unusable,false);
 const frozen=Buffer.alloc(96000);for(let i=0;i<frozen.length;i+=2)frozen.writeInt16LE(1000,i);quiet.add(frozen);assert.equal(quiet.unusable,true);
});

test('fallback skips a failed input temporarily and returns to the primary after recovery',async()=>{
 let now=0,primaryWorks=false;const attempts=[],events=[];
 const router=new MicrophoneRouter({mode:'auto',read:async()=>report,now:()=>now,onChange:e=>events.push(e),createCapture:route=>({route,async start(){attempts.push(route.id);if(route.source==='carthing'&&!primaryWorks)throw Error('unavailable')},async stop(){}})});
 assert.equal((await router.open()).route.name,'MacBook microphone');assert.deepEqual(attempts,['carthing','mac:MacBook microphone']);
 assert.equal(events.at(-1).fallback,true);
 attempts.length=0;assert.equal((await router.open()).route.name,'MacBook microphone');assert.deepEqual(attempts,['mac:MacBook microphone']);
 primaryWorks=true;now=31000;attempts.length=0;assert.equal((await router.open()).route.name,'Car Thing microphone');assert.deepEqual(attempts,['carthing']);
 assert(events.some(e=>e.type==='failed'));assert.equal(events.at(-1).type,'selected');assert.equal(events.at(-1).fallback,false);
});

test('failed Car Thing capture falls back to Mac; runtime failures move the next capture onward',async()=>{
 const attempts=[];let failure;
 const router=new MicrophoneRouter({mode:'auto',read:async()=>report,createCapture:(route,callbacks)=>({route,async start(){attempts.push(route.name);if(route.source==='carthing')throw Error('unavailable');if(route.name==='MacBook microphone')failure=callbacks.onError;},async stop(){}})});
 assert.equal((await router.open({onError:()=>{}})).route.name,'MacBook microphone');failure(Error('disconnected'));
 assert.equal((await router.open()).route.name,'AirPods');assert.deepEqual(attempts,['Car Thing microphone','MacBook microphone','AirPods']);
});

test('cancel during input startup never opens a fallback microphone',async()=>{
 const attempts=[];const controller=new AbortController();
 const router=new MicrophoneRouter({mode:'auto',read:async()=>report,createCapture:route=>({route,start:signal=>new Promise((_,reject)=>{attempts.push(route.id);signal.addEventListener('abort',()=>reject(new DOMException('Canceled','AbortError')),{once:true})}),async stop(){}})});
 const opening=router.open({signal:controller.signal});const rejection=assert.rejects(opening,{name:'AbortError'});await new Promise(r=>setTimeout(r,10));controller.abort();await rejection;assert.deepEqual(attempts,['carthing']);
});

test('process capture rejects all-zero PCM and preserves split sample boundaries',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'kitt-pcm-'));const fake=path.join(dir,'capture-v1');let capture;
 try{
  await writeFile(fake,'#!/usr/bin/env node\n// Revision 1. Silent capture fixture.\nprocess.stdout.write(Buffer.alloc(96000));setInterval(()=>{},1000);\n',{mode:0o700});
  capture=new PcmCapture({source:'mac',name:'test input',deviceName:'explicit input'},{spawnProcess:(command,args,options)=>spawn(process.execPath,[command],options),ffmpeg:fake});await assert.rejects(capture.start(),/silent|frozen/);assert(capture.stopped);
  await writeFile(fake,'#!/usr/bin/env node\n// Revision 2. Fragmented live capture fixture.\nconst b=Buffer.alloc(6400);for(let i=0;i<b.length;i+=2)b.writeInt16LE(i%4?200:-200,i);process.stdout.write(b.subarray(0,3));setTimeout(()=>process.stdout.write(b.subarray(3)),30);setInterval(()=>process.stdout.write(b),100);\n',{mode:0o700});
  const parts=[];capture=new PcmCapture({source:'mac',name:'test input',deviceName:'explicit input'},{spawnProcess:(command,args,options)=>spawn(process.execPath,[command],options),ffmpeg:fake,onData:b=>parts.push(b)});await capture.start();assert(parts.every(b=>b.length%2===0));assert.equal(Buffer.concat(parts).readInt16LE(0),-200);await capture.stop();assert(capture.children.every(child=>child.exitCode!==null||child.signalCode!==null));
 }finally{await capture?.stop();await rm(dir,{recursive:true,force:true})}
});

test('manual capture uses the router, preserves quiet requests and discards cancellation',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'kitt-routed-manual-'));let stopped=0;
 const microphones={async open({onData}){onData(Buffer.concat([pcm(),pcm(),pcm()]));return {route:carThingInput,async stop(){stopped++}}}};
 const audio=new AudioEngine({directory:dir,microphones});
 try{await audio.startCapture();const recorded=await audio.stopCapture();assert.equal(recorded.length,19200);assert.equal(recorded.readInt16LE(0),4800);await audio.startCapture();assert.equal(await audio.stopCapture(true),null);assert.equal(stopped,2)}
 finally{await audio.close();await rm(dir,{recursive:true,force:true})}
});
