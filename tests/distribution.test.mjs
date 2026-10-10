import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {speechConfig, streamSpeech} from '../speech.mjs';
import {ChatAssistant} from '../assistant/chat-assistant.mjs';
import {BrowserBridge, hostMode} from '../assistant/host-mode.mjs';
import {createKittServer} from '../assistant/kitt-server-v1.mjs';
import {acknowledgmentProfile, AcknowledgmentCache} from '../assistant/acknowledgments-v1.mjs';
import {executableAvailable} from '../assistant/executables.mjs';
import {validateBackup} from '../scripts/device-backup.mjs';

const settings = {TTS_PROVIDER:'http',TTS_ENDPOINT:'http://127.0.0.1:9000/speech'};
const audio = () => new Response(new Uint8Array([1,2,3]), {headers:{'Content-Type':'audio/wav'}});

test('system speech is the default and does not select a vendor', () => {
  const config = speechConfig({}); assert.equal(config.provider,'system'); assert.equal(config.available,false); assert.equal(config.endpoint,'');
});
test('generic service sends only the configured contract with server-side credentials', async () => {
  let sent;
  const stream = await streamSpeech(' Hello ', {env:{...settings,TTS_API_KEY:'EXAMPLE_TEST_TOKEN',TTS_VOICE:'example',TTS_OPTIONS:'{"speed":1.1}'},fetch:async(url,options)=>{sent={url,...options}; return audio();}});
  assert.deepEqual([...new Uint8Array(await new Response(stream).arrayBuffer())],[1,2,3]);
  assert.equal(stream.contentType,'audio/wav');
  assert.deepEqual(JSON.parse(sent.body),{text:'Hello',voice:'example',speed:1.1});
  assert.equal(sent.headers.Authorization,'Bearer EXAMPLE_TEST_TOKEN'); assert.equal(sent.redirect,'error'); assert(!sent.url.includes('EXAMPLE_TEST_TOKEN'));
});
test('OpenAI-compatible local speech uses input and a fixed supported audio format', async () => {
  const stream = await streamSpeech('Test', {env:{...settings,TTS_PROVIDER:'openai-compatible',TTS_MODEL:'kokoro',TTS_VOICE:'af_heart',TTS_OPTIONS:'{"input":"override","response_format":"pcm"}'},fetch:async(url,options)=>{
    assert.deepEqual(JSON.parse(options.body),{input:'Test',response_format:'mp3',model:'kokoro',voice:'af_heart'}); assert(!options.headers.Authorization); return audio();
  }});
  await new Response(stream).arrayBuffer();
});
test('speech rejects credential URLs, insecure remote URLs, unknown providers, and invalid options', async () => {
  for (const endpoint of ['http://remote.example/speech','https://user:pass@example.com/speech','https://example.com/speech?key=EXAMPLE','https://example.com/speech#fragment','file:///speech']) {
    assert.throws(()=>speechConfig({...settings,TTS_ENDPOINT:endpoint}));
  }
  assert.throws(()=>speechConfig({TTS_PROVIDER:'unknown'}));
  for (const value of ['[]','null','{broken']) await assert.rejects(streamSpeech('text',{env:{...settings,TTS_OPTIONS:value},fetch:()=>assert.fail('must not call provider')}));
});
test('provider errors never expose the upstream body or transport diagnostic', async () => {
  for (const fetch of [async()=>new Response('EXAMPLE_PRIVATE_DIAGNOSTIC',{status:401}),async()=>{throw Error('EXAMPLE_PRIVATE_DIAGNOSTIC');}]) {
    await assert.rejects(streamSpeech('text',{env:settings,fetch}),error=>!error.message.includes('EXAMPLE_PRIVATE_DIAGNOSTIC'));
  }
});
test('invalid audio, cancellation, and oversized streams fail safely', async () => {
  await assert.rejects(streamSpeech('text',{env:settings,fetch:async()=>Response.json({url:'https://example.com/audio'})}),/MP3 or WAV/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(streamSpeech('text',{env:settings,signal:controller.signal,fetch:async(url,options)=>{options.signal.throwIfAborted();}}),/stopped/);
  const stream = await streamSpeech('text',{env:settings,fetch:async()=>new Response(new Uint8Array(16*1024*1024+1),{headers:{'Content-Type':'audio/mpeg'}})});
  await assert.rejects(new Response(stream).arrayBuffer(),/size limit/);
  const empty = await streamSpeech('text',{env:settings,fetch:async()=>new Response(new Uint8Array(),{headers:{'Content-Type':'audio/mpeg'}})});
  await assert.rejects(new Response(empty).arrayBuffer());
});
test('cache identities change with endpoint and do not contain credentials', () => {
  const profile = acknowledgmentProfile({...settings,TTS_API_KEY:'EXAMPLE_TEST_TOKEN'});
  const a = new AcknowledgmentCache({directory:'.',profile});
  const b = new AcknowledgmentCache({directory:'.',profile:acknowledgmentProfile({...settings,TTS_ENDPOINT:'http://localhost:9001/speech'})});
  assert.notEqual(a.key,b.key); assert(!JSON.stringify(profile).includes('EXAMPLE_TEST_TOKEN'));
});
test('browser host connects without ADB; device mode requires an explicit serial', () => {
  assert.equal(hostMode({}),'browser'); assert.throws(()=>hostMode({KITT_MODE:'carthing'}));
  assert.equal(hostMode({KITT_MODE:'carthing',KITT_ADB_SERIAL:'EXAMPLE_DEVICE'}),'carthing');
  let state; new BrowserBridge({onChange:value=>{state=value;}}).start(); assert.equal(state.connected,true); assert.equal(state.mode,'browser');
});
test('browser host serves the interface, denies private files, and accepts typed requests without USB', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(),'kittkarr-host-'));
  const saved = process.env.KITT_MODE; process.env.KITT_MODE='browser';
  const spoken=[];
  const app = await createKittServer({port:0,directory,inputMonitor:null,thinkingTone:null,
    audio:{initialize:async()=>{},check:async()=>({}),stopPlayback(){},stopCapture:async()=>{},speak:async text=>{spoken.push(text);},close:async()=>{}},
    assistant:new ChatAssistant({env:{}}),wake:{running:false,check:async()=>false,stop:async()=>{}}});
  try {
    await app.start(); const base=`http://127.0.0.1:${app.port}`;
    assert.equal(app.state().device.mode,'browser'); assert.equal((await fetch(base)).status,200);
    for(const file of ['/.env','/.git/config','/.kitt-state/private','/package.json','/assistant/chat-assistant.mjs']) assert.equal((await fetch(base+file)).status,404);
    const result=await fetch(base+'/api/ask',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-KITT-Intent':'1'},body:JSON.stringify({text:'Hello'})});
    assert.equal(result.status,200);
    for(let i=0;i<50&&!spoken.length;i++) await new Promise(resolve=>setTimeout(resolve,10));
    assert.match(spoken[0],/Configure a chat endpoint/);
  } finally {await app.close(); await rm(directory,{recursive:true,force:true}); if(saved===undefined)delete process.env.KITT_MODE;else process.env.KITT_MODE=saved;}
});
test('chat is offline until configured and keeps vendor credentials on the host', async () => {
  assert.match(await new ChatAssistant({env:{},fetch:()=>assert.fail()}).ask('Hello'),/Configure/);
  const assistant=new ChatAssistant({env:{CHAT_ENDPOINT:'http://localhost:1234/v1/chat/completions',CHAT_MODEL:'example',CHAT_API_KEY:'EXAMPLE_TEST_TOKEN'},fetch:async(url,options)=>{
    assert.equal(options.headers.Authorization,'Bearer EXAMPLE_TEST_TOKEN'); assert.equal(options.redirect,'error');
    assert(!options.body.includes('EXAMPLE_TEST_TOKEN'));
    return Response.json({choices:[{message:{content:'Ready.'}}]});
  }});
  assert.equal(await assistant.ask('Hello'),'Ready.'); assistant.close(); assert.equal(assistant.history.length,0);
});
test('executable lookup honors PATH instead of assuming a Homebrew prefix', async () => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'kittkarr-path-'));
  try { await writeFile(path.join(directory,'example-tool'),'fixture',{mode:0o700}); assert(await executableAvailable('example-tool',{PATH:directory})); assert(!await executableAvailable('missing',{PATH:directory})); }
  finally {await rm(directory,{recursive:true,force:true});}
});
test('device restoration rejects traversal and unrelated service targets', () => {
  const root=path.resolve('example-project'),home=path.resolve('example-home');
  const manifest={version:1,backup:path.join(root,'.kitt-state/backups/example'),collector:path.join(home,'Library/Application Support/CarThingCollector'),agent:path.join(home,'Library/LaunchAgents/com.carthing.kitt.plist'),serial:'EXAMPLE_DEVICE'};
  assert.equal(validateBackup(manifest,root,home),manifest);
  for(const patch of [{backup:path.join(root,'.kitt-state/backups/../outside')},{backup:path.join(root,'.kitt-state/backups')},{agent:path.join(home,'unrelated')},{collector:path.join(home,'unrelated')},{serial:''}]) assert.throws(()=>validateBackup({...manifest,...patch},root,home));
});
