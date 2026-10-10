// Revision 26. Verify cached acknowledgments, concurrent inference, persona isolation, and cancellation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Reminders } from '../assistant/reminders-v1.mjs';
import { AudioEngine, pcmToWav, envelope, beepPcm } from '../assistant/audio-v1.mjs';
import {AcknowledgmentCache,acknowledgmentPhrases,acknowledgmentProfile} from '../assistant/acknowledgments-v1.mjs';
import { WorkAssistant, isWorkReadTool, isLiveReadTool, workToolNames } from '../assistant/work-assistant-v1.mjs';
import { createKittServer, trustedRequest, spokenAnswer, brainMode, openMicEnabled, brainTimeoutMs } from '../assistant/kitt-server-v1.mjs';
import { transcriptionConfig, transcribeWithOpenAI } from '../assistant/openai-transcription-v1.mjs';
import { stripWakeWord, wakeCommand, wakeWords, WakeListener } from '../assistant/wake-listener-v1.mjs';
import { PersonaPreferences, personaInstructions } from '../assistant/persona-v1.mjs';
import { ListeningPreferences } from '../assistant/listening-preferences-v1.mjs';
import {ThinkingTone,thinkingPcm} from '../assistant/thinking-tone-v1.mjs';

test('OpenAI voice input sends a bounded WAV and uses the selected model',async()=>{
 const wav=pcmToWav(beepPcm(0,true));const env={OPENAI_API_KEY:'test-key',OPENAI_TRANSCRIPTION_MODEL:'test-transcription-model'};
 assert.equal(transcriptionConfig(env).provider,'openai');assert.equal(transcriptionConfig({}).provider,'local');
 assert.equal(transcriptionConfig({KITT_TRANSCRIPTION_PROVIDER:'openai'}).available,false);
 const text=await transcribeWithOpenAI(wav,{env,fetch:async(url,request)=>{
  assert.equal(url,'https://api.openai.com/v1/audio/transcriptions');assert.equal(request.headers.Authorization,'Bearer test-key');assert.equal(request.body.get('model'),'test-transcription-model');
  assert.equal(request.body.get('file').type,'audio/wav');assert.deepEqual(Buffer.from(await request.body.get('file').arrayBuffer()),wav);
  return Response.json({text:'  Check my calendar.  '});
 }});assert.equal(text,'Check my calendar.');
});
test('OpenAI transcription errors never reveal provider bodies or credentials',async()=>{
 const wav=pcmToWav(beepPcm(0,true));const env={OPENAI_API_KEY:'private-test-key'};
 await assert.rejects(transcribeWithOpenAI(wav,{env,fetch:async()=>Response.json({error:{message:'private-test-key'}},{status:401})}),error=>error.message.includes('credentials')&&!error.message.includes('private-test-key'));
 await assert.rejects(transcribeWithOpenAI(wav,{env,fetch:async()=>Response.json({text:'   '})}),/No speech/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(transcribeWithOpenAI(wav,{env,signal:controller.signal,fetch:async(_,request)=>{request.signal.throwIfAborted()}}),/stopped/);
});

test('reminders survive restart, deduplicate retries and announce overdue reminders once',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'kitt-reminders-'));let now=Date.parse('2026-10-05T18:00:00Z');
 try{const store=new Reminders(dir,{now:()=>now});await store.load();const input={text:'Review the design',dueAt:'2026-10-05T12:00:00-07:00',requestId:'same-call'};
 const [one,two]=await Promise.all([store.add(input),store.add(input)]);assert.equal(one.id,two.id);assert.equal(store.list().length,1);
 const restored=new Reminders(dir,{now:()=>now});await restored.load();assert.equal(restored.list()[0].text,input.text);
 now+=7200000;assert.equal((await restored.claimDue()).length,1);assert.equal((await restored.claimDue()).length,0);
 await restored.dismiss(one.id);assert.deepEqual(restored.list(),[]);
 await assert.rejects(restored.add({text:'Bad time',dueAt:'2026-10-06T12:00:00'}),/time zone/);
 await assert.rejects(restored.add({text:'Past',dueAt:'2026-10-04T12:00:00Z'}),/future/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('speech waveform preserves silence and switches play bounded dual-tone phone sounds',()=>{
 const silent=Buffer.alloc(3200);const wave=envelope(silent);assert.equal(wave.durationMs,100);assert.deepEqual(wave.levels,[0,0,0,0]);
 const one=beepPcm(0,true),two=beepPcm(1,true),off=beepPcm(0,false);assert.notDeepEqual(one,two);assert.deepEqual(one,off);assert.equal(envelope(one).durationMs,140);
 const samples=Array.from({length:one.length/2},(_,i)=>one.readInt16LE(i*2)/32768);
 assert.equal(samples[0],0);assert.equal(samples.at(-1),0);assert(Math.max(...samples.map(Math.abs))<=.28);
 const energy=frequency=>{let real=0,imaginary=0;for(let i=0;i<samples.length;i++){const phase=2*Math.PI*frequency*i/16000;real+=samples[i]*Math.cos(phase);imaginary+=samples[i]*Math.sin(phase)}return (real*real+imaginary*imaginary)/samples.length**2};
 assert(energy(697)>.004);assert(energy(1209)>.004);assert(energy(770)<.0001);assert(energy(1336)<.0001);
 const wav=pcmToWav(one);assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(40),one.length);assert.equal(wav.readUInt32LE(24),16000);
});
test('the work bridge rejects writes and unrelated connectors even with misleading names',()=>{
 assert(isWorkReadTool('gmail.search_emails',{annotations:{readOnlyHint:true}}));
 assert(!isWorkReadTool('gmail.send_email',{annotations:{readOnlyHint:false}}));
 assert(!isWorkReadTool('gmail.read_email',{annotations:{readOnlyHint:true,destructiveHint:true}}));
 assert(!isWorkReadTool('github.search',{annotations:{readOnlyHint:true}}));
 for(const forbidden of ['gmail.send_email','gmail.create_draft','google_calendar.create_event','google_drive.batch_update_document','slack.slack_send_message'])assert(!workToolNames.has(forbidden));
});
const liveTool={description:'Read current public information.',annotations:{readOnlyHint:true,destructiveHint:false},inputSchema:{type:'object',properties:{weather:{type:'array'},system2_search_query:{type:'array'},finance:{type:'array'}}}};
function sourceHarness(catalog,options={}){
 const client=new EventEmitter(),connector=new EventEmitter(),calls=[],responses=[];
 client.start=connector.start=async()=>{};
 client.request=async(method,params)=>{calls.push({side:'client',method,params});return method==='thread/start'?{thread:{id:'agent'}}:{turn:{id:'turn'}}};
 client.respond=(id,result)=>responses.push({id,result});
 connector.request=async(method,params)=>{
  calls.push({side:'connector',method,params});
  if(method==='app/installed'){if(options.installedError)throw new Error('App list unavailable');return {apps:[]}}
  if(method==='mcpServerStatus/list')return {data:[{name:'codex_apps',tools:catalog}]};
  if(method==='thread/start')return {thread:{id:'bridge'}};
  if(method==='mcpServer/tool/call')return {content:[{type:'text',text:'Current source data'}],isError:!!options.toolError,_meta:{privateInternal:'omit'}};
  throw new Error(method);
 };
 const assistant=new WorkAssistant({reminders:{list:()=>[]},cwd:os.tmpdir(),location:'Redwood City, CA',client,connector});
 return {assistant,calls,responses};
}
test('live access admits only the exact read-only web tool and works without work accounts',async()=>{
 assert(isLiveReadTool('search_service.web_run',liveTool));
 for(const name of ['search_service.send','github.search','gmail.send_email'])assert(!isLiveReadTool(name,liveTool));
 for(const annotations of [{},{readOnlyHint:false},{readOnlyHint:true,destructiveHint:true}])assert(!isLiveReadTool('search_service.web_run',{annotations}));
 const {assistant,calls}=sourceHarness({'search_service.web_run':liveTool,'gmail.send_email':liveTool,'github.search':liveTool},{installedError:true});
 const sources=await assistant.initialize();assert(sources.find(s=>s.name==='Live weather & public web').available);
 const start=calls.find(c=>c.side==='client'&&c.method==='thread/start').params;
 assert.equal(start.model,'gpt-6.1-sol');
 assert(start.dynamicTools.some(t=>t.name==='live_web'));assert(!start.dynamicTools.some(t=>t.name.includes('gmail')||t.name.includes('github')));
 assert.equal(start.config.web_search,'disabled');assert.equal(start.config['features.shell_tool'],false);
 assert.match(start.baseInstructions,/ALWAYS perform a fresh lookup/);assert.match(start.baseInstructions,/Never interpret no reported restrictions/);
});
test('live tool forwarding preserves arguments and evidence but omits internal metadata and reports failures',async()=>{
 for(const toolError of [false,true]){
  const {assistant,calls,responses}=sourceHarness({'search_service.web_run':liveTool},{toolError});await assistant.initialize();assistant.turn={};
  const args={weather:[{location:'Redwood City, CA',duration:1}],system2_search_query:[{q:'current Redwood City road alerts'}]};
  await assistant.handleRequest({id:1,method:'item/tool/call',params:{threadId:'agent',tool:'live_web',arguments:args}});
  assert.deepEqual(calls.find(c=>c.method==='mcpServer/tool/call').params,{threadId:'bridge',server:'codex_apps',tool:'search_service.web_run',arguments:args});
  assert.equal(responses[0].result.success,!toolError);
  const result=JSON.parse(responses[0].result.contentItems[0].text);assert(Number.isFinite(Date.parse(result.retrievedAt)));assert.equal(result.content[0].text,'Current source data');assert.equal(result._meta,undefined);
  assistant.sourceTools.set('forged',{name:'gmail.send_email',tool:liveTool});
  await assistant.handleRequest({id:2,method:'item/tool/call',params:{threadId:'agent',tool:'forged',arguments:{}}});
  assert.equal(responses[1].result.success,false);assert.equal(calls.filter(c=>c.method==='mcpServer/tool/call').length,1);
 }
});
test('missing web access remains explicit while reminders work and the turn gets its default location',async()=>{
 const {assistant,calls,responses}=sourceHarness({});const sources=await assistant.initialize();
 assert.equal(sources.find(s=>s.name==='Live weather & public web').available,false);
 const answer=assistant.ask('What is the weather?');const stopped=assert.rejects(answer,/stopped/);await new Promise(r=>setImmediate(r));
 const prompt=calls.find(c=>c.method==='turn/start').params.input[0].text;
 assert.match(prompt,/Redwood City, CA/);assert.match(prompt,/No GPS or default traffic route/);
 await assistant.handleRequest({id:1,method:'item/tool/call',params:{threadId:'agent',tool:'list_reminders',arguments:{}}});assert.equal(responses[0].result.success,true);
 await assistant.handleRequest({id:2,method:'item/tool/call',params:{threadId:'agent',tool:'live_web',arguments:{}}});assert.equal(responses[1].result.success,false);
 await assistant.cancel();await stopped;
});
test('local control requires the exact origin, JSON and intent header',()=>{
 const valid={headers:{host:'127.0.0.1:4180',origin:'http://127.0.0.1:4180','content-type':'application/json','x-kitt-intent':'1'}};
 assert(trustedRequest(valid,4180,true));
 for(const patch of [{origin:'https://attacker.example'},{host:'attacker.example:4180'},{origin:undefined},{'x-kitt-intent':undefined},{'content-type':'text/plain'}])assert(!trustedRequest({headers:{...valid.headers,...patch}},4180,true));
});
test('spoken responses keep readable labels and separate source links',()=>{
 assert.deepEqual(spokenAnswer('Read [the brief](https://docs.google.com/document/d/abc/edit).'),{text:'Read the brief.',links:[{label:'the brief',url:'https://docs.google.com/document/d/abc/edit'}]});
});
test('cancel during initialization never starts an unwanted assistant turn',async()=>{
 const client=new EventEmitter(),connector=new EventEmitter();let initialized;let starts=0;
 client.request=async()=>{starts++;throw new Error('Unexpected request')};
 const assistant=new WorkAssistant({reminders:{},cwd:os.tmpdir(),client,connector});
 assistant.initialize=()=>new Promise(resolve=>{initialized=resolve});
 const answer=assistant.ask('Old request');const rejected=assert.rejects(answer,/stopped/);
 await assistant.cancel();initialized();await rejected;await new Promise(resolve=>setImmediate(resolve));
 assert.equal(starts,0);assert.equal(assistant.turn,null);
});
test('cancel interrupts a pending turn start and late completion cannot replace the next answer',async()=>{
 const client=new EventEmitter(),connector=new EventEmitter();let started;const interrupted=[];let starts=0;
 client.request=async(method,params)=>{if(method==='turn/start'){starts++;return starts===1?new Promise(resolve=>{started=resolve}):{turn:{id:'new'}};}if(method==='turn/interrupt'){interrupted.push(params);return {}}throw new Error(method)};
 const assistant=new WorkAssistant({reminders:{},cwd:os.tmpdir(),client,connector});assistant.threadId='thread';assistant.initialize=async()=>[];
 const answer=assistant.ask('Old request');const rejected=assert.rejects(answer,/stopped/);await new Promise(resolve=>setImmediate(resolve));
 const canceled=assistant.cancel();started({turn:{id:'old'}});await canceled;await rejected;
 assert.deepEqual(interrupted,[{threadId:'thread',turnId:'old'}]);
 const next=assistant.ask('New request');await new Promise(resolve=>setImmediate(resolve));
 assistant.notification({method:'turn/completed',params:{threadId:'thread',turn:{id:'old',status:'interrupted'}}});
 assistant.notification({method:'item/completed',params:{threadId:'thread',turnId:'new',item:{type:'agentMessage',id:'message',phase:'final_answer',text:'New answer'}}});
 assistant.notification({method:'turn/completed',params:{threadId:'thread',turn:{id:'new',status:'completed'}}});
 assert.equal(await next,'New answer');
});
test('host blocks private files and prevents a canceled answer from speaking',async()=>{
 const previousBrain=process.env.KITT_BRAIN;process.env.KITT_BRAIN='codex';process.env.KITT_OPEN_MIC='0';
 const dir=await mkdtemp(path.join(os.tmpdir(),'kitt-host-'));let reply;let speechCount=0;
 const audio={volume:.7,initialize:async()=>{},check:async()=>({transcription:true,speech:'Test'}),stopPlayback(){},stopCapture:async()=>null,close:async()=>{},speak:async()=>{speechCount++}};
 const assistant={sources:[],initialize:async()=>[],ask:()=>new Promise(r=>{reply=r}),cancel:async()=>{},close(){}};
 const app=await createKittServer({port:0,directory:dir,audio,assistant,bridge:{start(){},stop(){}}});
 try{await app.start();const port=app.server.address().port;const base=`http://127.0.0.1:${port}`;
 const headers={Origin:base,'Content-Type':'application/json','X-KITT-Intent':'1'};
 assert.equal((await fetch(`${base}/.env`,{headers})).status,404);
 assert.equal((await fetch(`${base}/assistant/work-assistant-v1.mjs`,{headers})).status,404);
 assert.equal((await fetch(`${base}/api/ask`,{method:'POST',headers:{...headers,Origin:'https://bad.example'},body:JSON.stringify({text:'Read mail'})})).status,403);
 assert.equal((await fetch(`${base}/api/ask`,{method:'POST',headers,body:JSON.stringify({text:'Hello'})})).status,200);
 assert.equal(app.state().phase,'thinking');
 await fetch(`${base}/api/cancel`,{method:'POST',headers,body:'{}'});reply('Old answer');await new Promise(r=>setTimeout(r,20));
 assert.equal(speechCount,0);assert.equal(app.state().phase,'idle');
 }finally{await app.close();await rm(dir,{recursive:true,force:true});if(previousBrain===undefined)delete process.env.KITT_BRAIN;else process.env.KITT_BRAIN=previousBrain}
});

test('wake-word removal preserves command words and ignores partial-word matches',()=>{
 assert.deepEqual(wakeWords,['kitt','computer']);
 assert.equal(stripWakeWord('Hey KITT, check my calendar.'),'check my calendar.');
 assert.equal(stripWakeWord('Computer. Set a reminder.'),'Set a reminder.');
 assert.equal(stripWakeWord('Kit!'),'');
 assert.equal(stripWakeWord('Kitchen lights'),'Kitchen lights');
 assert.equal(stripWakeWord('Check the computer tomorrow.'),'Check the computer tomorrow.');
 assert.equal(wakeCommand('Hey computer, check my calendar.'),'check my calendar.');
 assert.equal(wakeCommand('Some background. Computer, tell me the time.'),'tell me the time.');
 assert.equal(wakeCommand('Computer.'),'');
 assert.equal(wakeCommand('This is computerized.'),null);
 assert.equal(wakeCommand('KITT, check my calendar.'),'check my calendar.');
 assert.equal(wakeCommand('Kit, tell me the time.'),'tell me the time.');
 assert.equal(wakeCommand('K.I.T.T., what is your name?'),'what is your name?');
 assert.equal(wakeCommand('The kitchen toolkit is ready.'),null);
 assert.equal(wakeCommand('The kitten is sleeping.'),null);
});
test('P1 nickname setting survives restart and serializes changes without changing identity',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'kitt-persona-'));
 try{
  const prefs=new PersonaPreferences(dir);await prefs.load();assert.equal(prefs.snapshot().michaelMode,false);
  await prefs.setMichaelMode(true);const restored=new PersonaPreferences(dir);await restored.load();
  assert.deepEqual(restored.snapshot(),{name:'KITT',michaelMode:true,addressAs:'Michael'});
  await assert.rejects(restored.setMichaelMode('false'),/true or false/);assert.equal(restored.michaelMode,true);
  await Promise.all([restored.setMichaelMode(false),restored.setMichaelMode(true),restored.setMichaelMode(false)]);
  const last=new PersonaPreferences(dir);await last.load();assert.equal(last.snapshot().addressAs,'Driver');assert(last.version>prefs.version);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('the model receives KITT identity and the current P1 mode on every turn',async()=>{
 const {assistant,calls}=sourceHarness({});await assistant.initialize();
 assert.match(calls.find(c=>c.side==='client'&&c.method==='thread/start').params.baseInstructions,/Your name is KITT/);
 for(const michaelMode of [true,false]){
  const answer=assistant.ask('My name is Jamie. What is your name?',{michaelMode});const rejection=assert.rejects(answer,/stopped/);
  await new Promise(r=>setImmediate(r));const prompt=calls.filter(c=>c.method==='turn/start').at(-1).params.input[0].text;
  assert.match(prompt,michaelMode?/P1 is ON.*Michael mode is enabled/:/P1 is OFF.*Michael mode is disabled/);
  assert.match(prompt,michaelMode?/applies to every speaker/:/Use Driver as a neutral form of address/);
  assert.match(prompt,michaelMode?/Michael Knight.*regardless/:/End the Knight Rider universe roleplay/);
  assert.match(prompt,/User request: My name is Jamie/);if(michaelMode)assert.match(prompt,/I'm sorry Michael/);
  await assistant.cancel();await rejection;
 }
});
test('P1 API reaches replies and wake acknowledgments, rejects invalid changes and persists',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'kitt-persona-host-')),spoken=[],options=[];let transcript='Kit.';
 const wake={running:false,check:async()=>true,async start(){this.running=true;this.onState(true)},async stop(){this.running=false;this.onState(false)}};
 const audio={initialize:async()=>{},check:async()=>({transcription:true}),close:async()=>{},transcribe:async()=>transcript,speak:async text=>spoken.push(text)};
 const assistant={sources:[],initialize:async()=>[],close(){},ask:async(text,context)=>{options.push(context);return context.michaelMode?'Certainly, Michael.':'Certainly, Driver.'}};
 const app=await createKittServer({port:0,directory:dir,audio,assistant,wake,bridge:{start(){this.onChange({connected:true})},stop(){}}});
 const settle=async()=>{for(let i=0;i<100;i++){if(app.state().phase==='idle')return;await new Promise(r=>setTimeout(r,10))}assert.fail('Voice turn did not finish')};
 try{
  await app.start();const base=`http://127.0.0.1:${app.port}`,headers={Origin:base,'Content-Type':'application/json','X-KITT-Intent':'1'};
  await fetch(base+'/api/wake',{method:'POST',headers,body:JSON.stringify({clientId:'persona-screen',active:true})});
  const post=value=>fetch(base+'/api/persona',{method:'POST',headers,body:JSON.stringify({michaelMode:value})});
  assert.equal((await post('yes')).status,400);assert.equal(app.state().persona.michaelMode,false);
  assert.equal((await post(true)).status,200);assert.equal(app.state().persona.addressAs,'Michael');
  const restored=new PersonaPreferences(dir);await restored.load();assert.equal(restored.michaelMode,true);
  wake.onWake('kitt');wake.onCommand(Buffer.alloc(32000));await settle();assert.equal(spoken.at(-1),'Yes, Michael?');
  transcript='KITT, say hello.';wake.onWake('kitt');wake.onCommand(Buffer.alloc(32000));await settle();assert.deepEqual(options.at(-1),{michaelMode:true});
  await post(false);wake.onWake('kitt');wake.onCommand(Buffer.alloc(32000));await settle();assert.deepEqual(options.at(-1),{michaelMode:false});assert.equal(spoken.at(-1),'Certainly, Driver.');
 }finally{await app.close();await rm(dir,{recursive:true,force:true})}
});
test('stopping a wake listener also cancels a start waiting for old capture shutdown',async()=>{
 const wake=new WakeListener();let release;wake.stopping=new Promise(resolve=>{release=resolve});
 const start=wake.start();const stop=wake.stop();release();await Promise.all([start,stop]);assert.equal(wake.running,false);
});
test('wake capture hands off once, pauses during replies, rearms and yields to manual recording',async()=>{
 const previousBrain=process.env.KITT_BRAIN;process.env.KITT_BRAIN='codex';process.env.KITT_OPEN_MIC='0';
 const dir=await mkdtemp(path.join(os.tmpdir(),'kitt-wake-host-'));let transcriptions=0,asks=[],speechDone,manualStarts=0;
 const wake={running:false,check:async()=>true,async start(){this.running=true;this.onState(true)},async stop(){this.running=false;this.onState(false)},finish(){this.onCommand(Buffer.alloc(32000),'computer')}};
 const audio={volume:.7,initialize:async()=>{},check:async()=>({transcription:true}),stopPlayback(){},stopCapture:async()=>null,startCapture:async()=>{assert.equal(wake.running,false);manualStarts++},transcribe:async()=>{transcriptions++;return 'Computer, check the time.'},speak:()=>new Promise(resolve=>{assert.equal(wake.running,false);speechDone=resolve}),close:async()=>{}};
 const assistant={sources:[],initialize:async()=>[],ask:async text=>{asks.push(text);return 'It is time for a break.'},cancel:async()=>{},close(){}};
 const app=await createKittServer({port:0,directory:dir,audio,assistant,wake,bridge:{start(){this.onChange({connected:true})},stop(){}}});
 const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,25))}assert.fail('Wake state did not settle')};
 try{
  await app.start();const base=`http://127.0.0.1:${app.port}`;const post=async(route,body={})=>fetch(base+'/api/'+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-KITT-Intent':'1'},body:JSON.stringify(body)});
  await post('wake',{clientId:'test-screen',active:true});await until(()=>wake.running);assert.equal(transcriptions,0,'Idle audio never transcribed');
  wake.onWake('computer');assert.equal(app.state().listenMode,'wake');await post('listen/stop');await until(()=>Boolean(speechDone));
  assert.equal(wake.running,false);assert.equal(transcriptions,1);assert.deepEqual(asks,['check the time.']);
  wake.onCommand(Buffer.alloc(32000),'computer');assert.equal(transcriptions,1,'Late duplicate command ignored');
  const endedAt=Date.now();speechDone();await until(()=>wake.running);
  assert(Date.now()-endedAt<800,'Wake capture should restart promptly after playback');
  await post('listen/start');assert.equal(manualStarts,1);assert.equal(app.state().listenMode,'manual');assert.equal(wake.running,false);
  await post('cancel');await post('wake',{clientId:'test-screen',active:false});await new Promise(r=>setTimeout(r,300));assert.equal(wake.running,false);
 }finally{speechDone?.();await app.close();await rm(dir,{recursive:true,force:true});if(previousBrain===undefined)delete process.env.KITT_BRAIN;else process.env.KITT_BRAIN=previousBrain}
});
test('an abandoned screen lease releases the wake microphone without transcription',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'kitt-wake-lease-'));let stopped=0;
 const wake={running:false,check:async()=>true,async start(){this.running=true;this.onState(true)},async stop(){if(this.running)stopped++;this.running=false;this.onState(false)}};
 const audio={initialize:async()=>{},check:async()=>({transcription:true}),close:async()=>{},transcribe:async()=>assert.fail('Idle audio must stay local')};
 const assistant={sources:[],initialize:async()=>[],close(){}};
 const app=await createKittServer({port:0,directory:dir,audio,assistant,wake,wakeLeaseMs:100,bridge:{start(){this.onChange({connected:true})},stop(){}}});
 try{await app.start();const base=`http://127.0.0.1:${app.port}`;
 await fetch(base+'/api/wake',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-KITT-Intent':'1'},body:JSON.stringify({clientId:'closed-screen',active:true})});
 assert.equal(wake.running,true);await new Promise(r=>setTimeout(r,400));assert.equal(wake.running,false);assert.equal(stopped,1);
 }finally{await app.close();await rm(dir,{recursive:true,force:true})}
});
test('wake candidates need a real computer word before dispatch and failures retain their stage',async()=>{
 const previous={brain:process.env.KITT_BRAIN,open:process.env.KITT_OPEN_MIC};process.env.KITT_BRAIN='codex';process.env.KITT_OPEN_MIC='0';
 const dir=await mkdtemp(path.join(os.tmpdir(),'kitt-wake-validation-'));let transcript='The computerized toolkit is ready.';let requests=0;const spoken=[];
 const wake={running:false,check:async()=>true,async start(){this.running=true;this.onState(true)},async stop(){this.running=false;this.onState(false)}};
 const audio={initialize:async()=>{},check:async()=>({transcription:true}),close:async()=>{},transcribe:async()=>transcript,speak:async text=>spoken.push(text)};
 const assistant={model:'test-model',sources:[],initialize:async()=>[],close(){},ask:async()=>{requests++;throw Error('Lookup unavailable')}};
 const app=await createKittServer({port:0,directory:dir,audio,assistant,wake,bridge:{start(){this.onChange({connected:true})},stop(){}}});
 const settle=async()=>{for(let i=0;i<60;i++){if(['idle','error'].includes(app.state().phase))return;await new Promise(r=>setTimeout(r,10))}assert.fail('wake handoff stuck')};
 try{await app.start();assert.equal(app.state().assistant.model,'test-model');
  const base=`http://127.0.0.1:${app.port}`;await fetch(base+'/api/wake',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-KITT-Intent':'1'},body:JSON.stringify({clientId:'validation-screen',active:true})});
  wake.onWake('computer');wake.onCommand(Buffer.alloc(32000));await settle();assert.equal(requests,0);assert.equal(spoken.length,0);assert.equal(app.state().wake.lastRejection.transcript,transcript);
  transcript='Computer.';wake.onWake('computer');wake.onCommand(Buffer.alloc(32000));await settle();assert.deepEqual(spoken,['Yes, Driver?']);assert.equal(requests,0);
  transcript='Computer, check the weather.';wake.onWake('computer');wake.onCommand(Buffer.alloc(32000));await settle();assert.equal(requests,1);assert.equal(app.state().lastError.message,'Lookup unavailable');assert.equal(app.state().lastError.stage,'thinking');
  wake.onState(true);assert.equal(app.state().lastError.message,'Lookup unavailable');assert(app.state().diagnostics.some(e=>e.from==='listening'&&e.to==='transcribing'));
 }finally{await app.close();await rm(dir,{recursive:true,force:true});for(const [key,value]of [['KITT_BRAIN',previous.brain],['KITT_OPEN_MIC',previous.open]])if(value===undefined)delete process.env[key];else process.env[key]=value}
});

test('brain helpers default to a configured chat service while explicit Grok Bot mode remains available',()=>{
 assert.equal(brainMode({}),'chat');assert.equal(brainMode({KITT_BRAIN:'codex'}),'codex');assert.equal(brainMode({KITT_BRAIN:'responses'}),'responses');assert.equal(brainMode({KITT_BRAIN:'GrokBot'}),'grokbot');
 assert.equal(openMicEnabled({}),false);assert.equal(openMicEnabled({KITT_OPEN_MIC:'1'}),true);assert.equal(openMicEnabled({KITT_OPEN_MIC:'true'}),true);
 assert.equal(brainTimeoutMs({}),90000);assert.equal(brainTimeoutMs({KITT_BRAIN_TIMEOUT_MS:'120000'}),120000);
});
test('grokbot brain bridge claims pending asks, speaks replies, and rejects idle reply posts',async()=>{
 const previous={KITT_BRAIN:process.env.KITT_BRAIN,KITT_OPEN_MIC:process.env.KITT_OPEN_MIC,KITT_BRAIN_TIMEOUT_MS:process.env.KITT_BRAIN_TIMEOUT_MS,KITT_GROKBOT_WEBHOOK_URL:process.env.KITT_GROKBOT_WEBHOOK_URL};
 process.env.KITT_BRAIN='grokbot';process.env.KITT_OPEN_MIC='0';delete process.env.KITT_GROKBOT_WEBHOOK_URL;
 const dir=await mkdtemp(path.join(os.tmpdir(),'kitt-brain-'));let spoken=[];
 const audio={volume:.7,initialize:async()=>{},check:async()=>({transcription:true,speech:'Test'}),stopPlayback(){},stopCapture:async()=>null,close:async()=>{},speak:async text=>{spoken.push(text)}};
 const assistant={sources:[],initialize:async()=>[],ask:async()=>{throw new Error('Codex must not run in grokbot mode')},cancel:async()=>{},close(){}};
 const app=await createKittServer({port:0,directory:dir,audio,assistant,bridge:{start(){},stop(){}}});
 try{
  await app.start();const base=`http://127.0.0.1:${app.port}`;
  const headers={Origin:base,'Content-Type':'application/json','X-KITT-Intent':'1'};
  assert.deepEqual(await(await fetch(`${base}/api/brain/pending`)).json(),{pending:null});
  assert.equal((await fetch(`${base}/api/brain/reply`,{method:'POST',headers,body:JSON.stringify({id:'missing',text:'hi'})})).status,400);
  assert.equal((await fetch(`${base}/api/ask`,{method:'POST',headers,body:JSON.stringify({text:'Hello from Driver'})})).status,200);
  const until=async predicate=>{for(let i=0;i<80;i++){if(predicate())return;await new Promise(r=>setTimeout(r,25))}assert.fail('brain state did not settle')};
  await until(()=>app.state().phase==='thinking');
  const pending=await(await fetch(`${base}/api/brain/pending`)).json();
  assert.equal(typeof pending.id,'string');assert.equal(pending.text,'Hello from Driver');assert.equal(typeof pending.createdAt,'number');
  assert.deepEqual(await(await fetch(`${base}/api/brain/pending`)).json(),{pending:null});
  assert.equal((await fetch(`${base}/api/brain/reply`,{method:'POST',headers,body:JSON.stringify({id:pending.id,text:'Systems online, Driver.'})})).status,200);
  await until(()=>spoken.includes('Systems online, Driver.'));
  assert.equal(app.state().phase,'idle');
 }finally{
  await app.close();await rm(dir,{recursive:true,force:true});
  for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value}
 }
});


const waitFor=async predicate=>{for(let i=0;i<120;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10))}assert.fail('Listening state did not settle')};
async function listeningHarness({available=true,wakeLeaseMs=15000,thinkingTone}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'kitt-listening-'));
 const calls={capture:0,discard:0,transcribe:0};let endSpeech;
 const wake={running:false,check:async()=>available,async start(){this.running=true;this.onState(true)},async stop(){this.running=false;this.onState(false)}};
 const audio={initialize:async()=>{},check:async()=>({transcription:true}),close:async()=>{},stopPlayback(){endSpeech?.()},stopCapture:async discard=>{if(discard)calls.discard++;return Buffer.alloc(32000)},startCapture:async()=>{calls.capture++},transcribe:async()=>{calls.transcribe++;return 'KITT, hello'},speak:()=>new Promise(resolve=>{endSpeech=resolve})};
 const assistant={sources:[],initialize:async()=>[],ask:async()=>'Hello',cancel:async()=>{},close(){}};
 const bridge={start(){this.onChange({connected:true})},stop(){}};
 const app=await createKittServer({port:0,directory:dir,audio,assistant,wake,bridge,wakeLeaseMs,thinkingTone});await app.start();
 const base=`http://127.0.0.1:${app.port}`,headers={Origin:base,'Content-Type':'application/json','X-KITT-Intent':'1'};
 const post=(route,body={})=>fetch(base+'/api/'+route,{method:'POST',headers,body:JSON.stringify(body)});
 return {app,dir,calls,wake,audio,assistant,bridge,post,enter:()=>post('wake',{clientId:'device-screen',active:true}),leave:()=>post('wake',{clientId:'device-screen',active:false}),endSpeech:()=>endSpeech?.(),close:async()=>{endSpeech?.();await app.close();await rm(dir,{recursive:true,force:true})}};
}
test('P4 pause persists and heartbeats do not reenable it; entering KITT does',async()=>{
 const h=await listeningHarness();
 try{
  assert.equal((await h.post('listening',{enabled:true})).status,400);
  assert.equal((await h.post('listening',{enabled:'yes'})).status,400);
  await h.enter();await waitFor(()=>h.wake.running);
  assert.equal((await h.post('listening',{enabled:false})).status,200);assert.equal(h.wake.running,false);
  const restored=new ListeningPreferences(h.dir);await restored.load();assert.equal(restored.enabled,false);
  await h.enter();await new Promise(r=>setTimeout(r,300));assert.equal(h.wake.running,false,'Heartbeat preserves pause');
  await h.leave();await h.enter();await waitFor(()=>h.wake.running&&h.app.state().wake.enabled);
  assert.equal((await h.post('listening',{enabled:false})).status,200);
  await h.post('listening',{enabled:true});await waitFor(()=>h.wake.running);
 }finally{await h.close()}
});
test('other modes cannot capture even with open mic enabled or after reconnect',async()=>{
 const previous=process.env.KITT_OPEN_MIC;process.env.KITT_OPEN_MIC='1';const h=await listeningHarness({available:false});
 try{
  await new Promise(r=>setTimeout(r,300));assert.equal(h.calls.capture,0);assert.equal(h.wake.running,false);
  assert.equal((await h.post('listen/start')).status,400);
  h.bridge.onChange({connected:false});h.bridge.onChange({connected:true});
  await h.enter();await new Promise(r=>setTimeout(r,300));assert.equal(h.calls.capture,0,'Unavailable wake detector must not enable ungated recording');
  assert.equal((await h.post('listening',{enabled:true})).status,400);
  await h.leave();await h.post('voice-test');await waitFor(()=>h.app.state().phase==='speaking');h.endSpeech();await waitFor(()=>h.app.state().phase==='idle');
  assert.equal(h.calls.capture,0);assert.equal(h.wake.running,false);
 }finally{await h.close();if(previous===undefined)delete process.env.KITT_OPEN_MIC;else process.env.KITT_OPEN_MIC=previous}
});
test('leaving KITT discards wake and manual recording without submitting speech',async()=>{
 const h=await listeningHarness();
 try{
  await h.enter();await waitFor(()=>h.wake.running);h.wake.onWake('kitt');assert.equal(h.app.state().phase,'listening');
  await h.leave();await waitFor(()=>h.app.state().phase==='idle'&&!h.wake.running);
  h.wake.onCommand(Buffer.alloc(32000),'kitt');assert.equal(h.calls.transcribe,0);
  await h.enter();await waitFor(()=>h.wake.running);await h.post('listen/start');assert.equal(h.app.state().listenMode,'manual');
  const discarded=h.calls.discard;await h.leave();await waitFor(()=>h.app.state().phase==='idle');
  assert(h.calls.discard>discarded);assert.equal(h.calls.transcribe,0);assert.equal(h.wake.running,false);
 }finally{await h.close()}
});
test('P4 interrupts playback to listen and disabling during recording discards it',async()=>{
 const h=await listeningHarness();
 try{
  await h.enter();await waitFor(()=>h.wake.running);await h.post('voice-test');await waitFor(()=>h.app.state().phase==='speaking');
  assert.equal(h.wake.running,false);await h.post('listening',{enabled:true});await waitFor(()=>h.wake.running);
  assert.equal(h.app.state().phase,'idle');h.wake.onWake('computer');
  await h.post('listening',{enabled:false});h.wake.onCommand(Buffer.alloc(32000));
  assert.equal(h.calls.transcribe,0);assert.equal(h.app.state().phase,'idle');assert.equal(h.wake.running,false);
 }finally{await h.close()}
});
test('reply completion in another mode cannot reopen the microphone',async()=>{
 const h=await listeningHarness();
 try{
  await h.enter();await waitFor(()=>h.wake.running);await h.post('voice-test');await waitFor(()=>h.app.state().phase==='speaking');
  await h.leave();h.endSpeech();await waitFor(()=>h.app.state().phase==='idle');await new Promise(r=>setTimeout(r,300));
  assert.equal(h.wake.running,false);assert.equal(h.calls.capture,0);assert.equal(h.app.state().wake.screenActive,false);
  await h.enter();await waitFor(()=>h.wake.running);
 }finally{await h.close()}
});
test('screen loss interrupts capture startup before microphone readiness',async()=>{
 const h=await listeningHarness();let release;
 try{
  h.wake.start=async function(){this.running=true;await new Promise(resolve=>{release=resolve})};
  h.wake.stop=async function(){this.running=false;this.onState(false);release?.()};
  await h.enter();await waitFor(()=>Boolean(release));await h.leave();await waitFor(()=>!h.wake.running);assert.equal(h.app.state().wake.active,false);
 }finally{release?.();await h.close()}
});
test('an expired KITT screen lease also discards manual capture',async()=>{
 const h=await listeningHarness({wakeLeaseMs:180});
 try{await h.enter();await waitFor(()=>h.wake.running);await h.post('listen/start');assert.equal(h.app.state().phase,'listening');await waitFor(()=>h.app.state().phase==='idle');assert.equal(h.calls.transcribe,0);assert.equal(h.wake.running,false)}finally{await h.close()}
});

test('P1 roleplay keeps canon relationships and real facts separate; off fully resets it',()=>{
 const on=personaInstructions(true),off=personaInstructions(false);
 for(const name of ['Michael Knight','Devon Miles','Bonnie Barstow','April Curtis','Wilton Knight','RC3','KARR','Garthe Knight'])assert(on.includes(name));
 assert.match(on,/amnesia/);assert.match(on,/never an actual medical diagnosis/);assert.match(on,/preserve actual people, dates/);assert.match(on,/never rename his accounts or reminder records/);
 assert.match(off,/neutral form of address/);assert.match(off,/End the Knight Rider universe roleplay/);
});

test('an empty wake transcript gives spoken retry feedback and rearms instead of failing silently',async()=>{
 const h=await listeningHarness();let feedback;
 try{
  h.audio.transcribe=async()=>{throw Error('No speech was recognized. Press the dial and try again.')};
  h.audio.speak=async text=>{feedback=text};await h.enter();await waitFor(()=>h.wake.running);
  h.wake.onWake('computer');h.wake.onCommand(Buffer.alloc(32000));await waitFor(()=>Boolean(feedback)&&h.wake.running);
  assert.match(feedback,/didn't catch that, Driver/);assert.equal(h.app.state().lastError.stage,'transcribing');assert.equal(h.app.state().voiceInput.seconds,1);assert.equal(h.app.state().phase,'idle');
 }finally{await h.close()}
});

test('waveform input levels arrive during wake waiting but cannot leak into playback, pause or other modes',async()=>{
 const h=await listeningHarness();
 try{
  h.wake.onLevel(.2);assert.equal(h.app.state().micLevel,0);
  await h.enter();await waitFor(()=>h.wake.running);h.wake.onLevel(.15);
  assert.equal(h.app.state().micLevel,.15);assert(h.app.state().micUpdatedAt>0);
  await h.post('listening',{enabled:false});h.wake.onLevel(.3);assert.equal(h.app.state().micLevel,0);
  await h.post('listening',{enabled:true});await waitFor(()=>h.wake.running);
  await h.post('voice-test');await waitFor(()=>h.app.state().phase==='speaking');h.wake.onLevel(.4);assert.equal(h.app.state().micLevel,0);
  h.endSpeech();await waitFor(()=>h.app.state().phase==='idle');await h.leave();h.wake.onLevel(.4);assert.equal(h.app.state().micLevel,0);
 }finally{await h.close()}
});
test('answer connection failures are spoken once and wake listening resumes with diagnostics retained',async()=>{
 const h=await listeningHarness();const spoken=[];
 try{
  await h.enter();await waitFor(()=>h.wake.running);
  h.audio.speak=async text=>{spoken.push(text)};
  h.assistant.ask=async()=>{throw Error('The connection was interrupted while generating the answer. Please try again.')};
  await h.post('ask',{text:'Tell me something'});await waitFor(()=>spoken.length===1&&h.app.state().phase==='idle'&&h.wake.running);
  assert.match(spoken[0],/Driver.*lost the connection/);assert.equal(h.app.state().lastError.stage,'thinking');assert.equal(h.app.state().lastError.heard,'Tell me something');assert.equal(h.app.state().reply,spoken[0]);
 }finally{await h.close()}
});
test('cancelling a failing answer suppresses its late error speech',async()=>{
 const h=await listeningHarness();let reject;const spoken=[];
 try{
  await h.enter();await waitFor(()=>h.wake.running);h.audio.speak=async text=>spoken.push(text);
  h.assistant.ask=()=>new Promise((_,r)=>{reject=r});await h.post('ask',{text:'Tell me something'});await waitFor(()=>!!reject);
  await h.post('cancel');reject(Error('fetch failed'));await new Promise(r=>setTimeout(r,30));assert.equal(spoken.length,0);assert.equal(h.app.state().phase,'idle');
 }finally{await h.close()}
});
test('a failed speech player is not recursively retried as another spoken reply',async()=>{
 const h=await listeningHarness();let calls=0;
 try{
  await h.enter();await waitFor(()=>h.wake.running);h.audio.speak=async()=>{calls++;throw Error('Playback failed')};
  await h.post('ask',{text:'Say hello'});await waitFor(()=>!!h.app.state().lastError);assert.equal(calls,1);assert.equal(h.app.state().lastError.stage,'speaking');
 }finally{await h.close()}
});
test('thinking tones start only while thinking, stop before speech, and P1 stays enabled throughout',async()=>{
 let enabled=false,resolveAnswer;const calls=[];
 const tone={setActive(value){enabled=value;calls.push(value)},stop(){enabled=false}};const h=await listeningHarness({thinkingTone:tone});
 try{
  await h.enter();await waitFor(()=>h.wake.running);await h.post('persona',{michaelMode:true});
  h.assistant.ask=()=>new Promise(r=>{resolveAnswer=r});h.audio.speak=async()=>{assert.equal(enabled,false);assert.equal(h.app.state().persona.michaelMode,true)};
  await h.post('ask',{text:'Check the weather'});await waitFor(()=>!!resolveAnswer);assert.equal(enabled,true);assert.equal(h.app.state().persona.michaelMode,true);
  resolveAnswer('Sunny, Michael.');await waitFor(()=>h.app.state().phase==='idle');assert.equal(enabled,false);assert.equal(h.app.state().persona.michaelMode,true);
  const timing=h.app.state().recentTurns.at(-1);assert.equal(timing.heard,'Check the weather');assert(timing.answerMs>=0);assert.equal(timing.outcome,'idle');
  await h.post('ask',{text:'Another request'});await waitFor(()=>enabled);await h.leave();assert.equal(enabled,false);await h.post('cancel');resolveAnswer('Discarded');
 }finally{await h.close()}
});
test('thinking chirps remain bounded and canceled timers cannot start or restart playback',async()=>{
 const pcm=thinkingPcm();assert.equal(pcm.length,96000);assert(envelope(pcm).levels.some(n=>n>0));assert.equal(pcm.readInt16LE(0),0);assert.equal(pcm.readInt16LE(pcm.length-2),0);
 assert.notDeepEqual(thinkingPcm(1),pcm);assert.notDeepEqual(thinkingPcm(2),pcm);
 const dir=await mkdtemp(path.join(os.tmpdir(),'kitt-tones-'));const children=[];
 const tone=new ThinkingTone({directory:dir,delayMs:15,spawnProcess:()=>{const child=new EventEmitter();child.killed=false;child.kill=()=>{child.killed=true;child.emit('exit',0)};children.push(child);return child}});
 try{
  tone.setActive(true);tone.setActive(false);await new Promise(r=>setTimeout(r,30));assert.equal(children.length,0);
  tone.setActive(true);await waitFor(()=>children.length===1);tone.setActive(false);assert(children[0].killed);await new Promise(r=>setTimeout(r,550));assert.equal(children.length,1);
 }finally{tone.stop();await rm(dir,{recursive:true,force:true})}
});

test('acknowledgments persist, invalidate on voice changes, avoid repeats, and keep Michael out of normal mode',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'kitt-ack-'));
 const profile=acknowledgmentProfile({TTS_PROVIDER:'http',TTS_ENDPOINT:'http://localhost:8880/speech',TTS_API_KEY:'private-test-secret',TTS_VOICE:'test-voice',TTS_MODEL:'test-model'});
 const cache=new AcknowledgmentCache({directory,profile,random:()=>.5});let generated=0;
 const generate=async(text,file)=>{generated++;const pcm=beepPcm(0);await writeFile(file,pcmToWav(pcm));return envelope(pcm)};
 try{
  await cache.warm(generate);assert.deepEqual(cache.status(),{ready:12,total:12});assert.equal(generated,12);
  const texts=Array.from({length:8},()=>cache.take().text);assert.equal(new Set(texts).size,8);assert(texts.every(t=>!t.includes('Michael')));assert.notEqual(cache.take().text,texts.at(-1));
  const michael=Array.from({length:4},()=>cache.take({michaelMode:true}).text);assert.equal(new Set(michael).size,4);assert(michael.every(t=>t.includes('Michael')));
  const reload=new AcknowledgmentCache({directory,profile});await reload.warm(generate);assert.equal(generated,12);assert.equal(reload.status().ready,12);
  const changed=new AcknowledgmentCache({directory,profile:{...profile,voiceId:'another-voice'}});await changed.load();assert.equal(changed.take(),null);
  const settings=new AcknowledgmentCache({directory,profile:{...profile,settings:{stability:.7}}});assert.notEqual(cache.key,settings.key);
  const paths=cache.paths(acknowledgmentPhrases.normal[0]);assert(!(await readFile(paths.metadata,'utf8')).includes('private-test-secret'));
  await writeFile(paths.file,'corrupt');const recovered=new AcknowledgmentCache({directory,profile});await recovered.warm(generate);assert.equal(generated,13);assert.equal(recovered.status().ready,12);
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('answer synthesis starts while cached acknowledgment is playing; answer audio waits for it',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'kitt-ack-queue-')),audio=new AudioEngine({directory});let release,prepared=false,answerPlayed=false;
 const savedProvider=process.env.TTS_PROVIDER,savedEndpoint=process.env.TTS_ENDPOINT;process.env.TTS_PROVIDER='http';process.env.TTS_ENDPOINT='http://localhost:8880/speech';
 const original={key:process.env.TTS_API_KEY,voice:process.env.TTS_VOICE};process.env.TTS_API_KEY='test';process.env.TTS_VOICE='test';
 try{
  audio.acknowledgments={take:()=>({kind:'acknowledgment'})};
  audio.prepareVoiceClip=async()=>{prepared=true;return envelope(beepPcm(0))};
  audio.playPrepared=async clip=>{if(clip.kind==='acknowledgment')await new Promise(r=>{release=r});else answerPlayed=true};
  const acknowledgment=audio.acknowledge({michaelMode:false}),speaking=audio.speak('Here is the answer.',{beforePlayback:acknowledgment});
  await waitFor(()=>prepared);assert.equal(answerPlayed,false);release();await speaking;assert.equal(answerPlayed,true);
  prepared=false;answerPlayed=false;
  const canceledAck=audio.acknowledge({}),canceled=audio.speak('Discard this answer.',{beforePlayback:canceledAck});await waitFor(()=>prepared);audio.stopPlayback();release();await canceled;assert.equal(answerPlayed,false);
 }finally{for(const [name,value] of [['TTS_PROVIDER',savedProvider],['TTS_ENDPOINT',savedEndpoint],['TTS_API_KEY',original.key],['TTS_VOICE',original.voice]]){if(value===undefined)delete process.env[name];else process.env[name]=value}await audio.close();await rm(directory,{recursive:true,force:true})}
});

test('host starts inference during acknowledgment, suppresses tones until it ends, and preserves P1',async()=>{
 let toneActive=false,finishAck,answer;const h=await listeningHarness({thinkingTone:{setActive:v=>{toneActive=v},stop(){toneActive=false}}});
 try{
  await h.enter();await waitFor(()=>h.wake.running);await h.post('persona',{michaelMode:true});
  h.audio.acknowledge=persona=>{assert.equal(persona.michaelMode,true);assert.equal(h.wake.running,false);assert.equal(toneActive,false);return new Promise(r=>{finishAck=r})};
  h.assistant.ask=()=>new Promise(r=>{answer=r});
  h.audio.speak=async(text,{beforePlayback})=>{assert.equal(toneActive,false);await beforePlayback};
  await h.post('ask',{text:'Check something for me'});await waitFor(()=>!!answer);assert.equal(h.app.state().acknowledging,true);assert.equal(h.app.state().phase,'thinking');assert.equal(toneActive,false);
  finishAck();await waitFor(()=>toneActive);assert.equal(h.app.state().persona.michaelMode,true);answer('Done, Michael.');await waitFor(()=>h.app.state().phase==='idle');assert.equal(toneActive,false);
  answer=null;await h.post('ask',{text:'Another request'});await waitFor(()=>!!answer);await h.post('cancel');finishAck();answer('Do not speak this');await new Promise(r=>setTimeout(r,20));assert.equal(h.app.state().phase,'idle');assert.equal(toneActive,false);
 }finally{finishAck?.();answer?.('Stopped');await h.close()}
});

test('failed or missing acknowledgment never prevents the actual answer',async()=>{
 const h=await listeningHarness();let replies=0;
 try{
  await h.enter();h.audio.speak=async(text,{beforePlayback})=>{await beforePlayback;replies++};
  for(const acknowledge of [()=>null,()=>Promise.reject(Error('Clip unavailable')),()=>{throw Error('Cache unavailable')}]){
   h.audio.acknowledge=acknowledge;await h.post('ask',{text:'Say hello'});await waitFor(()=>h.app.state().phase==='idle');
  }
  assert.equal(replies,3);
 }finally{await h.close()}
});
