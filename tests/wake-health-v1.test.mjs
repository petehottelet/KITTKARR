// Revision 3. A warming decoder becomes ready as soon as it catches up with live audio.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WakeHealth} from '../assistant/wake-health-v1.mjs';

test('continuous near-real-time audio stays armed and stale decoding goes dark',()=>{
  let now=0;const health=new WakeHealth({now:()=>now});health.receive(3200);
  assert.equal(health.status().active,false,'Opening a stream alone is not readiness');
  for(let second=1;second<=60;second++){
    now=second*1100;health.receive(32000);health.meter(second);
    assert.equal(health.status().active,true);assert.equal(health.status().error,null);
    now+=700;assert.equal(health.status().active,true,'Normal space between meter events is healthy');
  }
  now+=2000;assert.equal(health.status().active,false);assert.match(health.status().error,/stopped processing/);
});
test('quarter-speed capture never lights P4 even with real changing samples',()=>{
  let now=0;const health=new WakeHealth({now:()=>now});health.receive(3200);
  now=4000;health.receive(28800);health.meter(1);
  assert.equal(health.status().active,false);assert.match(health.status().error,/too slowly/);assert.equal(health.status().rate,.25);
});
test('the first quarter-second can be ready without waiting for the one-second meter',()=>{
 let now=0;const health=new WakeHealth({now:()=>now});health.receive(3200);
 now=280;health.receive(5120);health.meter(.26);
 assert.equal(health.status().active,true);assert.equal(health.status().error,null);
});
test('a quarter-second arriving too slowly does not briefly advertise readiness',()=>{
 let now=0;const health=new WakeHealth({now:()=>now});health.receive(3200);
 now=1000;health.receive(5120);health.meter(.26);
 assert.equal(health.status().active,false);
 now=2000;health.receive(8000);health.meter(.51);
 assert.equal(health.status().active,false);assert.match(health.status().error,/too slowly/);
});
test('startup model loading may defer readiness, then fast catch-up can arm before one second',()=>{
 let now=0;const health=new WakeHealth({now:()=>now});health.receive(3200);
 now=440;health.receive(10880);health.meter(.26);assert.equal(health.status().active,false);
 now=460;health.meter(.38);assert.equal(health.status().active,true);assert.equal(health.status().error,null);
});
test('decoder backlog extinguishes readiness before it can grow without bound',()=>{
  let now=0;const health=new WakeHealth({now:()=>now});health.receive(3200);
  now=1000;health.receive(28800);health.meter(1);assert.equal(health.status().active,true);
  now=2700;health.receive(54400);assert.equal(health.status().active,false);assert.match(health.status().error,/fell behind/);
});
test('capture slowing after startup is detected without waiting for a complete stall',()=>{
  let now=0;const health=new WakeHealth({now:()=>now});health.receive(3200);
  for(let s=1;s<=5;s++){now=s*1000;health.receive(32000);health.meter(s)}
  assert.equal(health.status().active,true);
  now=9000;health.receive(32000);health.meter(6);
  assert.equal(health.status().active,false);assert.match(health.status().error,/too slowly/);
});
test('a detector that never produces a meter times out without advertising readiness',()=>{
  let now=0;const health=new WakeHealth({now:()=>now});now=8001;
  assert.equal(health.status().active,false);assert.match(health.status().error,/did not receive/);
});
