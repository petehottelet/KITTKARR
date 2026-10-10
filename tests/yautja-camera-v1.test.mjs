// Revision 5. Track each viewer stream independently during reconnects.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {YautjaCamera} from '../assistant/yautja-camera-v1.mjs';

function fixture(options={}){
  const processes=[];
  const camera=new YautjaCamera({...options,spawnProcess:()=>{
    const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),pid:999999,killed:[]});
    child.kill=signal=>{child.killed.push(signal);queueMicrotask(()=>child.emit('exit',0));};processes.push(child);return child;
  }});
  const response=()=>{const out=new EventEmitter();Object.assign(out,{chunks:[],writableLength:0,ended:false,writeHead(code,headers){this.code=code;this.headers=headers;},write(data){this.chunks.push(Buffer.from(data))},end(){this.ended=true;this.emit('close')}});return out;};
  return {camera,processes,response};
}
test('another live viewer cannot hide this viewer\'s disconnected stream',()=>{
  const{camera,response}=fixture();try{
    camera.lease('viewer-first-123',true);camera.lease('viewer-other-456',true);
    const first=response();camera.attach('viewer-first-123',first);camera.attach('viewer-other-456',response());
    assert.equal(camera.snapshot('viewer-first-123').viewerConnected,true);
    first.emit('close');
    assert.equal(camera.snapshot('viewer-first-123').viewerConnected,false);
    assert.equal(camera.snapshot('viewer-other-456').viewerConnected,true);
    assert.equal(camera.snapshot().subscribers,1);
  }finally{camera.close()}
});
test('camera needs a valid active lease and stream close releases capture',()=>{
  const{camera,processes,response}=fixture();try{
    assert.equal(camera.attach('unknown',response()),false);assert.equal(processes.length,0);
    assert.throws(()=>camera.lease('../no',true));camera.lease('viewer-123456',true);camera.lease('viewer-123456',true);assert.equal(processes.length,1);
    const stream=response();assert.equal(camera.attach('viewer-123456',stream),true);stream.emit('close');
    assert.equal(camera.snapshot().running,false);assert.equal(camera.sessions.size,0);assert.deepEqual(processes[0].killed,['SIGTERM']);
  }finally{camera.close()}
});
test('split JPEG frames assemble once and slow viewers cannot backlog capture',()=>{
  const{camera,processes,response}=fixture({now:()=>1000});try{
    camera.lease('viewer-123456',true);const stream=response();camera.attach('viewer-123456',stream);
    const jpeg=Buffer.from([255,216,11,22,255,217]),header=Buffer.alloc(4);header.writeUInt32BE(jpeg.length);
    const packet=Buffer.concat([header,jpeg]);processes[0].stdout.write(packet.subarray(0,3));assert.equal(camera.snapshot().frames,0);
    processes[0].stdout.write(packet.subarray(3));assert.equal(camera.snapshot().frames,1);assert.ok(Buffer.concat(stream.chunks).includes(jpeg));assert.equal(camera.snapshot().frameAgeMs,0);
    const count=stream.chunks.length;stream.writableLength=300000;processes[0].stdout.write(packet);assert.equal(camera.snapshot().frames,2);assert.equal(stream.chunks.length,count);
    camera.lease('viewer-123456',false);assert.equal(camera.frame,null);
  }finally{camera.close()}
});
test('expired visibility lease stops the camera even without a browser unload event',async()=>{
  let now=0;const{camera,processes}=fixture({now:()=>now,leaseMs:100});try{
    camera.lease('viewer-123456',true);now=101;await new Promise(resolve=>setTimeout(resolve,1050));
    assert.equal(camera.snapshot().running,false);assert.deepEqual(processes[0].killed,['SIGTERM']);
  }finally{camera.close()}
});
test('malformed frame sizes stop capture and report a recoverable error',()=>{
  const{camera,processes}=fixture();try{
    camera.lease('viewer-123456',true);const header=Buffer.alloc(4);header.writeUInt32BE(10000000);processes[0].stdout.write(header);
    assert.equal(camera.snapshot().running,false);assert.match(camera.snapshot().error,/decoded/);assert.equal(camera.frame,null);
  }finally{camera.close()}
});

test('a failed viewer socket releases capture without an uncaught response error',()=>{
  const{camera,processes,response}=fixture();try{
    camera.lease('viewer-123456',true);const stream=response();camera.attach('viewer-123456',stream);
    stream.emit('error',new Error('socket disconnected'));
    assert.equal(camera.snapshot().running,false);assert.equal(camera.streams.size,0);assert.deepEqual(processes[0].killed,['SIGTERM']);
  }finally{camera.close()}
});

test('dial presets wrap both ways without restarting capture or losing viewers',()=>{
  const{camera,processes,response}=fixture();try{
    assert.throws(()=>camera.advance('viewer-123456',1),/Open Yautja/);
    camera.lease('viewer-123456',true);const stream=response();camera.attach('viewer-123456',stream);
    assert.equal(camera.advance('viewer-123456',-1).preset,'noumenon');
    assert.equal(camera.advance('viewer-123456',1).preset,'yautja');
    assert.equal(camera.advance('viewer-123456',2).preset,'murphy');
    assert.equal(camera.advance('viewer-123456',9).preset,'murphy');
    const lines=processes[0].stdin.read().toString().trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map(x=>x.preset),['noumenon','yautja','murphy','murphy']);
    assert.equal(processes.length,1);assert.equal(camera.streams.size,1);assert.equal(stream.ended,false);
    assert.deepEqual(processes[0].killed,[]);
    processes[0].stderr.write('{"event":"preset","preset":"murphy"}\n');
    assert.equal(camera.snapshot().appliedPreset,'murphy');
  }finally{camera.close()}
});

test('preset changes reject invalid directions, expired leases, and blocked controls',()=>{
  let now=0;const{camera,processes}=fixture({now:()=>now,leaseMs:100});try{
    camera.lease('viewer-123456',true);
    for(const delta of [0,49,-49,NaN,1.5,'1',null])assert.throws(()=>camera.advance('viewer-123456',delta),/Invalid/);
    assert.equal(camera.snapshot().preset,'yautja');
    now=101;assert.throws(()=>camera.advance('viewer-123456',1),/Open Yautja/);
    now=0;processes[0].stdin.destroy();assert.throws(()=>camera.advance('viewer-123456',1),/reconnecting/);
  }finally{camera.close()}
});

test('failed controls stop capture safely and keep the selected preset for retry',()=>{
  const{camera,processes}=fixture();try{
    camera.lease('viewer-123456',true);camera.advance('viewer-123456',2);
    processes[0].stdin.emit('error',new Error('EPIPE'));
    assert.equal(camera.snapshot().running,false);assert.match(camera.snapshot().error,/control disconnected/);
    camera.lease('viewer-123456',false);camera.lease('viewer-123456',true);
    assert.equal(camera.snapshot().preset,'murphy');assert.equal(processes.length,2);
    processes[0].stderr.write('{"error":"old process"}\n');assert.equal(camera.snapshot().error,null);
  }finally{camera.close()}
});
