import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {sseData} from '../assistant/sse.mjs';
import {AnswerSpeechStream, SpeechTextQueue} from '../assistant/answer-stream-v1.mjs';
import {playSpeechStream} from '../assistant/speech-queue-v1.mjs';
import {ChatAssistant} from '../assistant/chat-assistant.mjs';
import {ResponsesAssistant} from '../assistant/responses-assistant-v1.mjs';
import {spokenAnswer} from '../assistant/spoken-answer-v1.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const event=value=>'data: '+JSON.stringify(value)+'\r\n\r\n';

test('SSE supports fragmented UTF-8, CRLF and bounded cancellation',async()=>{
  const bytes=new TextEncoder().encode('data: café\r\n\r\ndata: last');
  const response=new Response(new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));controller.close()}}));
  const results=[];for await(const data of sseData(response))results.push(data);assert.deepEqual(results,['café','last']);
  await assert.rejects(async()=>{for await(const data of sseData(new Response('data: toolong\n\n'),undefined,4))void data},/size limit/);
});

test('phrases start before completion while amounts, names, links and citations remain intact',()=>{
  const phrases=[],stream=new AnswerSpeechStream(text=>phrases.push(text));
  stream.update('Dr. Smith reports $12.50 today. More');
  assert.deepEqual(phrases,['Dr. Smith reports $12.50 today.']);
  stream.update('Dr. Smith reports $12.50 today. More [details](https://example.com).');
  assert.equal(phrases.length,1);
  stream.update('Dr. Smith reports $12.50 today. More [details](https://example.com).',{final:true});
  assert.deepEqual(phrases,['Dr. Smith reports $12.50 today.','More details.']);
  const text='The value is 12.5. [1]';
  assert.equal(spokenAnswer(text,{citations:[{start_index:text.indexOf('[1]'),end_index:text.length}]}).text,'The value is 12.5.');
  assert.throws(()=>stream.update('Changed answer',{final:true}),/changed/);
});

test('streamed speech plays one phrase while later text is still arriving',async()=>{
  const input=new SpeechTextQueue(),controller=new AbortController(),played=[];
  const running=playSpeechStream(input,{signal:controller.signal,abort:()=>controller.abort(),prepare:async text=>text,play:async text=>played.push(text)});
  input.push('First phrase.');await tick();assert.deepEqual(played,['First phrase.']);
  input.push('Second phrase.');input.close();await running;assert.deepEqual(played,['First phrase.','Second phrase.']);
});

test('stopping while waiting for text cancels every pending reader',async()=>{
  const input=new SpeechTextQueue(),controller=new AbortController();
  const running=playSpeechStream(input,{signal:controller.signal,abort:()=>controller.abort(),prepare:()=>assert.fail(),play:()=>assert.fail()});
  controller.abort();await assert.rejects(running);assert.equal(input.waiters.length,0);assert.equal(input.closed,true);
});

test('chat exposes text before completion and rejects truncated streams without storing history',async()=>{
  const finish=deferred(),early=deferred();
  const assistant=new ChatAssistant({env:{CHAT_ENDPOINT:'http://127.0.0.1:9000/chat',CHAT_MODEL:'example'},fetch:async(_url,options)=>{
    assert.equal(JSON.parse(options.body).stream,true);
    return new Response(new ReadableStream({async start(controller){
      controller.enqueue(new TextEncoder().encode(event({choices:[{delta:{content:'First answer. '}}]})));await finish.promise;
      controller.enqueue(new TextEncoder().encode(event({choices:[{delta:{content:'Second sentence.'},finish_reason:'stop'}]})+'data: [DONE]\n\n'));controller.close();
    }}),{headers:{'Content-Type':'text/event-stream'}});
  }});
  const result=assistant.ask('Example request',{onText:text=>early.resolve(text)});
  assert.equal(await early.promise,'First answer. ');assert.equal(assistant.history.length,0);
  finish.resolve();assert.equal(await result,'First answer. Second sentence.');assert.equal(assistant.history.length,2);
  assistant.fetch=async()=>new Response(event({choices:[{delta:{content:'Partial'}}]}),{headers:{'Content-Type':'text/event-stream'}});
  await assert.rejects(assistant.ask('Next',{onText:()=>{}}),/interrupted/);assert.equal(assistant.history.length,2);
});

const client=()=>Object.assign(new EventEmitter(),{close(){},start:async()=>{},request:async()=>({})});
test('Responses streams only final-answer items and does not retry after emitted text',async()=>{
  let requests=0;const updates=[];
  const assistant=new ResponsesAssistant({apiKey:'EXAMPLE',client:client(),connector:client(),fetch:async()=>{
    requests++;return new Response([
      {type:'response.output_item.added',item:{id:'plan',type:'message',phase:'commentary'}},
      {type:'response.output_text.delta',item_id:'plan',delta:'Private planning.'},
      {type:'response.output_item.added',item:{id:'answer',type:'message',phase:'final_answer'}},
      {type:'response.output_text.delta',item_id:'answer',delta:'The answer is ready. Next'}
    ].map(event).join(''),{headers:{'Content-Type':'text/event-stream'}});
  }});
  try{
    await assert.rejects(assistant.requestResponse({},new AbortController().signal,text=>updates.push(text)),/after speech started/);
    assert.equal(requests,1);assert.deepEqual(updates,['The answer is ready. Next']);
  }finally{assistant.close()}
});
