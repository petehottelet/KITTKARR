import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DEFAULT_EFFECTS, FILTER_PRESETS, SPACE_PRESETS, ROBOT_STYLES, normalizeEffects, processPCM16, EffectsPreferences, effectsProfileKey} from '../assistant/audio-effects-v1.mjs';
import {envelope} from '../assistant/audio-v1.mjs';
import {speechConfig, streamSpeech} from '../speech.mjs';

const tone=()=>{const pcm=Buffer.alloc(16000);for(let i=0;i<8000;i++)pcm.writeInt16LE(Math.round(Math.sin(i/16000*2*Math.PI*440)*22000),i*2);return pcm};
test('disabled effects preserve samples and every enabled preset stays finite and bounded',()=>{
  const pcm=tone();assert.deepEqual(processPCM16(pcm),pcm);
  for(const filter of FILTER_PRESETS)for(const space of SPACE_PRESETS)for(const robot of ROBOT_STYLES){
    const result=processPCM16(pcm,{...DEFAULT_EFFECTS,enabled:true,filter:filter.id,space:space.id,robotStyle:robot.id});
    assert(result.length>=pcm.length&&result.length<=pcm.length+28800);
    for(let i=0;i<result.length;i+=2)assert(Math.abs(result.readInt16LE(i))<=31130);
    if(filter.id!=='none')assert.notDeepEqual(result,pcm);
  }
});
test('room tails appear in the LED waveform and dry mix adds no tail',()=>{
  const pcm=tone(),config={...DEFAULT_EFFECTS,enabled:true,space:'hall'};
  assert(envelope(processPCM16(pcm,config)).durationMs>envelope(pcm).durationMs);
  assert.deepEqual(processPCM16(pcm,{...config,wetMix:0}),pcm);
  assert.throws(()=>processPCM16(Buffer.alloc(3),config));
  for(const patch of [{enabled:'yes'},{filter:'unknown'},{wetMix:NaN},{outputGain:2},{path:'example'}])assert.throws(()=>normalizeEffects(patch));
});
test('effects persist independently per voice without recording identifiers or credentials',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'kitt-effects-'));
  try{
    const env={TTS_PROVIDER:'http',TTS_ENDPOINT:'http://127.0.0.1:9000/speech',TTS_VOICE:'EXAMPLE_VOICE',TTS_API_KEY:'EXAMPLE_TEST_TOKEN'};
    const a=new EffectsPreferences(directory,{key:effectsProfileKey(env)});await a.load();
    await Promise.all([a.set({enabled:true}),a.set({filter:'robot'}),a.set({space:'hall'})]);
    const b=new EffectsPreferences(directory,{key:effectsProfileKey(env)});await b.load();assert.equal(b.config().space,'hall');assert.equal(b.config().filter,'robot');
    const other=new EffectsPreferences(directory,{key:effectsProfileKey({...env,TTS_VOICE:'DIFFERENT_VOICE'})});await other.load();assert.deepEqual(other.config(),DEFAULT_EFFECTS);
    const saved=await readFile(a.file,'utf8');assert(!saved.includes('EXAMPLE_VOICE'));assert(!saved.includes('EXAMPLE_TEST_TOKEN'));assert(!saved.includes('127.0.0.1'));
  }finally{await rm(directory,{recursive:true,force:true})}
});
test('local speech defaults to loopback WAV and never forwards remote credentials or options',async()=>{
  const env={TTS_PROVIDER:'local',TTS_API_KEY:'EXAMPLE_TEST_TOKEN',TTS_OPTIONS:'{"path":"example"}'};
  assert.equal(speechConfig(env).endpoint,'http://127.0.0.1:4181/v1/audio/speech');
  await streamSpeech('Example',{env,fetch:async(url,options)=>{
    assert.equal(options.headers.Authorization,undefined);assert.deepEqual(JSON.parse(options.body),{input:'Example',model:'qwen-local',voice:'local',response_format:'wav'});
    return new Response(new Uint8Array([1]),{headers:{'Content-Type':'audio/wav'}});
  }});
  assert.throws(()=>speechConfig({...env,TTS_ENDPOINT:'https://example.com/speech'}),/loopback/);
});
