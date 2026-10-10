// Revision 3. Model legacy ADB shells that return zero despite remote failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DeviceBridge} from '../assistant/device-bridge-v1.mjs';

function fixture({connected=true,healthy=true,repairWorks=true}={}){
  const calls=[],states=[];
  const bridge=new DeviceBridge({deploy:false,onChange:s=>states.push(s.connected),runner:async(_command,args)=>{
    const action=args[2];calls.push(action);
    if(action==='get-state')return {stdout:connected?'device\n':'offline\n'};
    if(action==='reverse'){healthy=repairWorks;return {stdout:''};}
    if(action==='shell')return {stdout:healthy?'KITT_HTTP_OK\r\n':"wget: can't connect to remote host (127.0.0.1): Connection refused\r\n"};
    return {stdout:''};
  }});
  return {bridge,calls,states,lose:()=>{healthy=false}};
}
test('healthy HTTP tunnel is not rebound on successive ticks',async()=>{
  const f=fixture();await f.bridge.tick();await f.bridge.tick();
  assert.deepEqual(f.states,[true,true]);assert.equal(f.calls.includes('reverse'),false);
});
test('a missing tunnel is restored and verified, including after a reconnect',async()=>{
  const f=fixture({healthy:false});await f.bridge.tick();f.lose();await f.bridge.tick();
  assert.deepEqual(f.states,[true,true]);assert.equal(f.calls.filter(x=>x==='reverse').length,2);
});
test('successful ADB reverse alone cannot claim a working connection',async()=>{
  const f=fixture({healthy:false,repairWorks:false});await f.bridge.tick();
  assert.deepEqual(f.states,[false]);assert.equal(f.bridge.connected,false);
});
test('offline devices cannot trigger a reverse mapping',async()=>{
  const f=fixture({connected:false});await f.bridge.tick();
  assert.deepEqual(f.states,[false]);assert.deepEqual(f.calls,['get-state']);
});
test('dashboard recovery is available even when the HTTP tunnel is broken',async()=>{
  const f=fixture({healthy:false,repairWorks:false});let deployed=false;
  f.bridge.deploy=true;f.bridge.ensureDashboard=async()=>{deployed=true};
  await f.bridge.tick();assert.equal(deployed,true);assert.deepEqual(f.states,[false]);
});
test('empty successful shell output cannot hide a failed HTTP probe',async()=>{
  const bridge=new DeviceBridge({deploy:false,runner:async()=>({stdout:''})});
  await assert.rejects(()=>bridge.probe(),/cannot reach/);
});
