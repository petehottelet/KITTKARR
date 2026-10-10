// Revision 4. Verify direct traffic tool discovery, invocation, and credential-dependent routing.
import {test} from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {ResponsesAssistant,nativeTools,responseText} from '../assistant/responses-assistant-v1.mjs';
import {clockAnswer} from '../assistant/clock-answer-v1.mjs';
const message=text=>({type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text,annotations:[]}]});
const done=output=>({status:'completed',model:'gpt-6.1-sol',output});
test('Responses exposes direct traffic with no work accounts and adds door-to-door routing only with a key',async()=>{
 const traffic={routingAvailable:false,conditions:async args=>({scope:args,sources:[{source:'Caltrans',postedTravelTimes:[{minutes:25}]}]}),route:async()=>({durationSeconds:1500})};
 let n=0,requests=[];const a=new ResponsesAssistant({apiKey:'test',traffic,client:client(),connector:client(),cwd:'/tmp',fetch:async(_,r)=>{const b=JSON.parse(r.body);requests.push(b);return Response.json(n++===0?done([{type:'function_call',call_id:'traffic1',name:'live_traffic',arguments:'{"highway":101}'}]):done([message('The sign reports 25 minutes.')]))}});a.connectSources=async()=>[];
 try{
  await a.initialize();assert(a.toolDefinitions.some(t=>t.name==='live_traffic'));assert(!a.toolDefinitions.some(t=>t.name==='traffic_route'));
  await a.ask('Current traffic on 101?');assert.match(requests[0].instructions,/ALWAYS call live_traffic/);assert(!requests[0].instructions.includes('No GPS or live routing provider is configured'));
  assert(requests[1].input.some(i=>i.type==='function_call_output'&&JSON.parse(i.output).scope.highway===101));assert.deepEqual(a.lastUsage.toolCalls,['live_traffic']);
  traffic.routingAvailable=true;await a.connect();assert(a.toolDefinitions.some(t=>t.name==='traffic_route'));
 }finally{a.close()}
});
const client=()=>Object.assign(new EventEmitter(),{close(){},start:async()=>{},request:async()=>({})});
function harness(fetchImpl){
 class Harness extends ResponsesAssistant{async connect(){this.toolDefinitions=nativeTools('Redwood City, CA');return this.sources}}
 return new Harness({apiKey:'example-key',fetch:fetchImpl,reminders:{list:()=>[]},client:client(),connector:client(),cwd:'/tmp',location:'Redwood City, CA'});
}
test('Responses uses live native tools, replays function results, and changes persona each turn',async()=>{
 const requests=[];let count=0;
 const a=harness(async(url,request)=>{assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(request.headers.Authorization,'Bearer example-key');requests.push(JSON.parse(request.body));count++;
  return Response.json(count===1?done([{type:'reasoning',id:'r1',encrypted_content:'encrypted',summary:[]},{type:'function_call',call_id:'call1',name:'list_reminders',arguments:'{}'}]):done([message(count===2?'Michael, your list is empty.':'Your name is Driver.')]));});
 try{
  assert.match(await a.ask('Read my reminders',{michaelMode:true}),/Michael/);assert.equal(requests[0].store,false);assert.equal(requests[0].reasoning.effort,'low');
  assert.equal(requests[0].tools.find(t=>t.type==='web_search').external_web_access,true);assert.equal(requests[0].tools.find(t=>t.type==='web_search').user_location.city,'Redwood City, CA');
  assert(requests[1].input.some(i=>i.type==='reasoning'&&i.encrypted_content==='encrypted'));assert(requests[1].input.some(i=>i.type==='function_call_output'&&i.output==='[]'));
  await a.ask('What is my name?',{michaelMode:false});assert.match(requests[2].instructions,/P1 is OFF/);assert.match(requests[2].instructions,/neutral form of address/);assert.equal(requests[2].input.at(-1).content,'What is my name?');
 }finally{a.close()}
});
test('native citations become safe display links and commentary is not spoken as the answer',()=>{
 const text='It is 68 degrees. [1]';const result=responseText([{...message('Searching…'),phase:'commentary'}, {type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text,annotations:[{type:'url_citation',start_index:18,end_index:21,url:'https://weather.gov/forecast',title:'NOAA'}]}]}]);
 assert.equal(result,'It is 68 degrees. [NOAA](https://weather.gov/forecast)');assert.equal(responseText([message('Answer citeturn0search0')]),'Answer');
});
test('Responses consumes streamed completion and reports built-in work without exposing provider errors',async()=>{
 const statuses=[];const a=harness(async()=>new Response('event: response.web_search_call.searching\ndata: {"type":"response.web_search_call.searching"}\n\nevent: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:done([message('Fresh answer')])})+'\n\n',{headers:{'content-type':'text/event-stream'}}));a.onStatus=s=>statuses.push(s);
 try{assert.equal(await a.ask('Weather now'),'Fresh answer');assert.deepEqual(statuses,['Searching the web…']);a.fetch=async()=>Response.json({error:{message:'example-key'}},{status:401});await assert.rejects(a.ask('Again'),error=>/credentials/.test(error.message)&&!error.message.includes('example-key'))}finally{a.close()}
});
test('cancel aborts an active Responses request and prevents old output or tools from running',async()=>{
 let started,finish;const pending=new Promise(r=>{started=r});const a=harness(async(_,request)=>{started();return new Promise(resolve=>{finish=()=>resolve(Response.json(done([{type:'function_call',call_id:'x',name:'create_reminder',arguments:'{}'}])));request.signal.addEventListener('abort',finish,{once:true})})});let called=false;a.callTool=async()=>{called=true};
 try{const answer=a.ask('A request');const rejection=assert.rejects(answer,/stopped/);await pending;await a.cancel();await rejection;assert.equal(called,false);assert.equal(a.history.length,0)}finally{finish?.();a.close()}
});
test('unknown work actions cannot acquire write access through Responses',async()=>{
 let n=0;const requests=[];const a=harness(async(_,r)=>{requests.push(JSON.parse(r.body));return Response.json(n++===0?done([{type:'function_call',call_id:'x',name:'work_gmail_send_email',arguments:'{}'}]):done([message('I cannot send mail.')]));});
 try{await a.ask('Send mail');const output=requests[1].input.find(i=>i.type==='function_call_output');assert.match(output.output,/not available/)}finally{a.close()}
});
test('a network failure retries once with identical input and speaks only the completed answer',async()=>{
 let count=0;const requests=[],statuses=[];const a=harness(async(_,r)=>{requests.push(r.body);if(++count===1)throw new TypeError('fetch failed',{cause:Object.assign(Error('socket closed'),{code:'ECONNRESET'})});return Response.json(done([message('Recovered answer')]));});a.onStatus=s=>statuses.push(s);
 try{assert.equal(await a.ask('Say hello'),'Recovered answer');assert.equal(count,2);assert.equal(requests[0],requests[1]);assert.deepEqual(statuses,['Connection interrupted. Retrying…']);assert.equal(a.history.length,1)}finally{a.close()}
});
test('retrying an interrupted function-result response does not execute the function again',async()=>{
 let count=0,calls=0;const a=harness(async()=>{
  count++;if(count===1)return Response.json(done([{type:'function_call',call_id:'once',name:'create_reminder',arguments:'{}'}]));
  if(count===2)return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'unfinished'})+'\n\n',{headers:{'content-type':'text/event-stream'}});
  return Response.json(done([message('Reminder saved.')]));
 });a.callTool=async()=>{calls++;return {id:'saved-once'}};
 try{assert.equal(await a.ask('Create my reminder'),'Reminder saved.');assert.equal(calls,1);assert.equal(count,3)}finally{a.close()}
});
test('server errors get one retry, authentication errors do not, and failed turns leave no history',async()=>{
 for(const status of [503,401]){
  let count=0;const a=harness(async()=>{count++;return Response.json({error:{message:'example-key'}},{status})});
  try{await assert.rejects(a.ask('Hello'),e=>!e.message.includes('example-key')&&/connection|credentials/i.test(e.message));assert.equal(count,status===503?2:1);assert.equal(a.history.length,0);assert.equal(a.responseTurn,null)}finally{a.close()}
 }
});
test('cancelling during retry backoff prevents another request and spoken output',async()=>{
 let count=0;const a=harness(async()=>{count++;throw new TypeError('fetch failed')});a.onStatus=()=>{void a.cancel()};
 try{await assert.rejects(a.ask('Hello'),/stopped/);assert.equal(count,1);assert.equal(a.history.length,0)}finally{a.close()}
});
test('date/time answers use Pacific calendar boundaries, honor P1, and reject compound questions',async()=>{
 const now=new Date('2026-10-07T01:05:00Z');
 assert.equal(clockAnswer('What day is it?',{now,timeZone:'America/Los_Angeles'}),"It's Tuesday, October 6, 2026, Driver.");
 assert.equal(clockAnswer('What time is it?',{now,michaelMode:true,timeZone:'America/Los_Angeles'}),"It's 6:05 PM, Michael.");
 assert.equal(clockAnswer('Can you tell me what time it is?',{now,timeZone:'America/Los_Angeles'}),"It's 6:05 PM, Driver.");
 assert.equal(clockAnswer('What time?',{now,timeZone:'America/Los_Angeles'}),"It's 6:05 PM, Driver.");
 assert.equal(clockAnswer('Can you tell me what day it is?',{now,timeZone:'America/Los_Angeles'}),"It's Tuesday, October 6, 2026, Driver.");
 assert.equal(clockAnswer('What time is it?',{now:new Date('2026-12-07T01:05:00Z'),timeZone:'America/Los_Angeles'}),"It's 5:05 PM, Driver.");
 for(const q of ['What day is my flight?','What day is it and what is the weather?','What time is it in Paris?','Remind me what day it is tomorrow'])assert.equal(clockAnswer(q,{now,timeZone:'America/Los_Angeles'}),null);
 const a=harness(async()=>{throw Error('Clock question must not call OpenAI')});a.initialize=async()=>{throw Error('Clock question must not wait for source discovery')};
 try{assert.match(await a.ask('What day is it?',{michaelMode:true}),/Michael/);assert.equal(a.lastUsage.model,'mac-clock');assert.equal(a.history.length,1);assert.match(await a.ask("What's today's date?",{michaelMode:false}),/Driver/);assert.equal(a.history.length,2)}finally{a.close()}
});
