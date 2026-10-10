// Revision 1. Early playback, ordered sections and cancellation of prefetched speech.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const modulePromise=import('../assistant/speech-queue-v1.mjs');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};

test('speech sections preserve the bounded reply, amounts, and sentence boundaries',async()=>{
 const {speechChunks}=await modulePromise;
 const text='Your first update is ready for you, Driver. The proposal costs $9,100 monthly, with a two-month minimum. '+('Please review the proposal before approving it. '.repeat(8)).trim();
 const chunks=speechChunks(text);
 assert.equal(chunks[0],'Your first update is ready for you, Driver.');
 assert.equal(chunks.join(' '),text);assert(chunks.slice(1).every(s=>s.length<=350));
 assert.equal(speechChunks('Hello.').join(''),'Hello.');assert.deepEqual(speechChunks('   '),[]);
 assert.equal(speechChunks('x'.repeat(1500)).join('').length,1000);
});

test('first section plays before the later generation completes, without reordering',async()=>{
 const {playSpeechQueue}=await modulePromise;
 const later=deferred(),played=[],started=[],firstPlayed=deferred(),controller=new AbortController();
 const queue=playSpeechQueue(['first','second','third'],{signal:controller.signal,abort:()=>controller.abort(),prepare:async(text,index)=>{started.push(index);if(index===1)await later.promise;return text},play:async text=>{played.push(text);if(text==='first')firstPlayed.resolve()}});
 await firstPlayed.promise;assert.deepEqual(played,['first']);assert(started.includes(1));later.resolve();await queue;
 assert.deepEqual(played,['first','second','third']);
});

test('interrupting playback cancels the prefetched section and never starts the next one',async()=>{
 const {playSpeechQueue}=await modulePromise;
 const controller=new AbortController(),played=[],started=[];let pendingStopped=false;
 const queue=playSpeechQueue(['first','second','third'],{signal:controller.signal,abort:()=>controller.abort(),prepare:(text,index)=>{started.push(index);return index===0?text:new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>{pendingStopped=true;reject(new Error('stopped'))},{once:true}))},play:async text=>{played.push(text);controller.abort()}});
 await assert.rejects(queue,/abort/i);assert(pendingStopped);assert.deepEqual(played,['first']);assert.deepEqual(started,[0,1]);
});

test('failed look-ahead is handled and surfaced after the first section, with cleanup awaited',async()=>{
 const {playSpeechQueue}=await modulePromise;
 const controller=new AbortController(),played=[];
 await assert.rejects(playSpeechQueue(['first','second'],{signal:controller.signal,abort:()=>controller.abort(),prepare:async(text,index)=>{if(index)throw new Error('provider unavailable');return text},play:async text=>{played.push(text);await new Promise(r=>setTimeout(r,10))}}),/provider unavailable/);
 assert.deepEqual(played,['first']);assert(controller.signal.aborted);
});
