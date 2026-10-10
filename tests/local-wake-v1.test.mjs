// Revision 1. Check direct-address recognition, bounded queueing and cancellation.
import test from 'node:test';import assert from 'node:assert/strict';
import {LocalWakeVerifier,localWakeWord} from '../assistant/local-wake-v1.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
test('local wake backup requires direct address and rejects incidental or partial words',()=>{
 for(const text of ['Computer, tell me the time.','Hey computer.','Okay, computer!'])assert.equal(localWakeWord(text),'computer');
 for(const text of ['KITT, hello.','Kit.','K.I.T.T., tell me the time.'])assert.equal(localWakeWord(text),'kitt');
 for(const text of ['The computer is running.','I need a toolkit.','Kitchen lights.','Computerized accounting.','Keep it quiet.','[BLANK_AUDIO]',''])assert.equal(localWakeWord(text),null);
});
test('local wake backup keeps one active utterance and replaces the pending one',async()=>{
 const pending=[],calls=[],hits=[];const v=new LocalWakeVerifier({transcribe:pcm=>{calls.push(pcm[0]);return new Promise(r=>pending.push(r))},onMatch:(pcm,word)=>hits.push({id:pcm[0],word})});
 v.offer(Buffer.alloc(32000,1));v.offer(Buffer.alloc(32000,2));v.offer(Buffer.alloc(32000,3));assert.deepEqual(calls,[1]);
 pending.shift()('Ordinary speech.');await tick();assert.deepEqual(calls,[1,3]);pending.shift()('Computer, hello.');await tick();assert.deepEqual(hits,[{id:3,word:'computer'}]);v.offer(Buffer.alloc(32000,4));assert.deepEqual(calls,[1,3]);await v.stop();
});
test('local wake cancellation prevents late recognition from triggering capture',async()=>{
 let finish,signal;const hits=[];const v=new LocalWakeVerifier({transcribe:(_,s)=>{signal=s;return new Promise(r=>finish=r)},onMatch:()=>hits.push(true)});
 v.offer(Buffer.alloc(32000));v.offer(Buffer.alloc(32000));const stopping=v.stop();assert(signal.aborted);finish('Computer, hello.');await stopping;assert.deepEqual(hits,[]);assert.equal(v.pending,null);
});
test('local recognition failures are contained and do not publish ambient transcripts',async()=>{
 const diagnostics=[];const v=new LocalWakeVerifier({transcribe:async()=>{throw Error('sensitive provider text')},onDiagnostic:x=>diagnostics.push(x)});v.offer(Buffer.alloc(32000));await tick();assert(diagnostics.some(x=>x.error));assert(!JSON.stringify(diagnostics).includes('sensitive'));await v.stop();
});
