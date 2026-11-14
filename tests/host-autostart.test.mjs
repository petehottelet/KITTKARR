import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startInstalledHost} from '../assistant/host-autostart.mjs';
import {controlHeadless} from '../scripts/kitt-control-v1.mjs';

test('auto-start bootstraps only a missing installed agent and never kills an existing host',async()=>{
  const calls=[];
  const run=async(command,args)=>{calls.push({command,args});if(args[0]==='print')throw Error('not loaded')};
  await startInstalledHost({platform:'darwin',uid:()=>501,home:'example-home',exists:async()=>{},run});
  assert.deepEqual(calls.map(call=>call.args[0]),['print','bootstrap','kickstart']);
  assert(!calls.some(call=>call.args.includes('-k')));
  calls.length=0;await startInstalledHost({platform:'darwin',uid:()=>501,run:async(_command,args)=>calls.push(args),exists:()=>assert.fail()});
  assert.deepEqual(calls.map(call=>call[0]),['print','kickstart']);
});
test('missing service and platform errors are useful without exposing process diagnostics',async()=>{
  await assert.rejects(startInstalledHost({platform:'win32'}),/macOS/);
  await assert.rejects(startInstalledHost({platform:'darwin',uid:()=>501,run:async()=>{throw Error('EXAMPLE_PRIVATE_DIAGNOSTIC')},exists:async()=>{throw Error('EXAMPLE_PRIVATE_DIAGNOSTIC')}}),error=>error.message.includes('Install')&&!error.message.includes('EXAMPLE_PRIVATE_DIAGNOSTIC'));
});
test('run and resume start offline hosts, but status, pause, stop and HTTP errors never do',async()=>{
  for(const command of ['run','start','resume']){
    let attempts=0,started=0;
    const state=await controlHeadless(command,{startHost:async()=>{started++},sleep:async()=>{},fetch:async()=>{
      if(attempts++===0)throw Error('offline',{cause:{code:'ECONNREFUSED'}});
      return Response.json({headless:{enabled:true},wake:{active:true}});
    }});
    assert.equal(started,1);assert.equal(state.headless.enabled,true);
  }
  for(const command of ['status','pause','stop'])await assert.rejects(controlHeadless(command,{startHost:()=>assert.fail(),fetch:async()=>{throw Error('offline',{cause:{code:'ECONNREFUSED'}})}}));
  await assert.rejects(controlHeadless('run',{startHost:()=>assert.fail(),fetch:async()=>new Response('{}',{status:403})}),/rejected/);
  await assert.rejects(controlHeadless('run',{startHost:async()=>{},sleep:async()=>{},startupAttempts:2,fetch:async()=>{throw Error('offline',{cause:{code:'ECONNREFUSED'}})}}),/did not become ready/);
});
