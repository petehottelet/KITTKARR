import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createKittServer} from '../assistant/kitt-server-v1.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10))}assert.fail('Timed out waiting for the test host')}
async function fixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),'kitt-stream-host-'));
  const finish=deferred(),spoken=[];let canceled=0,late;
  const assistant={supportsStreaming:true,initialize:async()=>[],cancel:async()=>{canceled++;finish.resolve()},close(){finish.resolve()},async ask(_text,{onText}){onText('The first sentence is ready. Another');late=onText;await finish.promise;return 'The first sentence is ready. Another sentence follows.'}};
  const audio={initialize:async()=>{},check:async()=>({speech:'local'}),stopPlayback(){},stopCapture:async()=>{},close:async()=>{},speak:async text=>spoken.push(text),async speakStream(queue,{onStart}){let first=true;for await(const text of queue){if(first){onStart();first=false}spoken.push(text)}}};
  const wake={running:false,check:async()=>false,stop:async()=>{}};
  const app=await createKittServer({port:0,directory,assistant,audio,wake,inputMonitor:null,thinkingTone:null});
  t.after(async()=>{finish.resolve();await app.close();await rm(directory,{recursive:true,force:true})});
  await app.start();const base=`http://127.0.0.1:${app.port}`;
  const post=(route,body)=>fetch(base+'/api/'+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-KITT-Intent':'1'},body:JSON.stringify(body)});
  return {app,post,spoken,finish,get canceled(){return canceled},get late(){return late}};
}

test('host begins speech before inference completes and delivers the final answer once',async t=>{
  const f=await fixture(t);await f.post('ask',{text:'Example request'});
  await until(()=>f.spoken.length===1);assert.equal(f.app.state().phase,'speaking');assert.equal(f.spoken[0],'The first sentence is ready.');
  f.finish.resolve();await until(()=>f.app.state().phase==='idle');
  assert.deepEqual(f.spoken,['The first sentence is ready.','Another sentence follows.']);
  assert.equal(f.app.state().reply,'The first sentence is ready. Another sentence follows.');
});

test('stop discards queued speech and a late streamed delta cannot revive playback',async t=>{
  const f=await fixture(t);await f.post('ask',{text:'Example request'});await until(()=>f.spoken.length===1);
  await f.post('cancel',{});assert.throws(()=>f.late('An obsolete sentence arrives. More'),/stopped/);
  await new Promise(r=>setTimeout(r,25));assert.equal(f.spoken.length,1);assert.equal(f.app.state().phase,'idle');
});

test('valid effect changes stop a live reply; invalid changes preserve it',async t=>{
  const f=await fixture(t);await f.post('ask',{text:'Example request'});await until(()=>f.spoken.length===1);
  const before=f.canceled;assert.equal((await f.post('effects',{filter:'bad'})).status,400);assert.equal(f.canceled,before);
  assert.equal((await f.post('effects',{enabled:true,filter:'robot',space:'hall'})).status,200);
  assert(f.canceled>before);assert.equal(f.app.state().effects.filter,'robot');assert.equal(f.app.state().effects.space,'hall');assert.equal(f.app.state().phase,'idle');
});
