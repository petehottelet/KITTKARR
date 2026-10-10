// Revision 1. Verify reconnects and cancellation against the shipped viewer script.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../yautja-v1.js',import.meta.url),'utf8');
const settle=async()=>{for(let n=0;n<4;n++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(){
  const timers=new Map(),intervals=new Map(),calls=[],classes=new Set();let timerId=0;
  const target=()=>({listeners:new Map(),addEventListener(type,fn){this.listeners.set(type,fn)},fire(type,event={}){this.listeners.get(type)?.(event)}});
  const feed={...target(),naturalWidth:640,removeAttribute(){delete this.src}},elements={'#feed':feed,'#message':{},'#retry':target(),'#preset-announcement':{}};
  const document={...target(),hidden:false,querySelector:key=>elements[key],body:{classList:{add:s=>classes.add(s),remove:s=>classes.delete(s)}}};
  const window=target(),control={failStart:false,pendingStart:null,state:{ready:true,frameAgeMs:30,viewerConnected:true,subscribers:1}};
  const fetch=async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):null;calls.push({url,body});
    if(body?.active&&control.failStart)throw Error('Connection refused');
    if(body?.active&&control.pendingStart){const wait=control.pendingStart;control.pendingStart=null;await wait;}
    return {ok:true,json:async()=>url.startsWith('/api/yautja/status')?control.state:{ok:true}};
  };
  vm.runInNewContext(source,{document,window,parent:{postMessage(){}},crypto:{randomUUID:()=> 'viewer-test-123456'},fetch,AbortSignal,Date,encodeURIComponent,setTimeout:fn=>{timers.set(++timerId,fn);return timerId},clearTimeout:id=>timers.delete(id),setInterval:fn=>{intervals.set(++timerId,fn);return timerId},clearInterval:id=>intervals.delete(id)});
  return {feed,document,window,calls,control,timers,classes,async tick(){for(const fn of intervals.values())fn();await settle()},async retry(){for(const[id,fn]of [...timers]){timers.delete(id);fn()}await settle()}};
}
test('startup failure retries and resumes a decoded live image',async()=>{
  const f=fixture();f.control.failStart=true;await settle();assert.equal(f.timers.size,1);assert.equal(f.feed.src,undefined);
  f.control.failStart=false;await f.retry();assert.match(f.feed.src,/api\/yautja\/stream/);
  await f.tick();assert.equal(f.classes.has('ready'),true);
  f.window.fire('pagehide');await settle();assert.equal(f.timers.size,0);
});
test('lost viewer stream reconnects even while another viewer is healthy',async()=>{
  const f=fixture();await settle();await f.tick();assert.equal(f.classes.has('ready'),true);
  f.control.state.viewerConnected=false;await f.tick();assert.equal(f.classes.has('ready'),false);assert.equal(f.feed.src,undefined);assert.equal(f.timers.size,1);
  f.control.state.viewerConnected=true;await f.retry();await f.tick();assert.equal(f.classes.has('ready'),true);
  f.window.fire('pagehide');await settle();
});
test('a broken image stream retries, but leaving the mode cancels recovery',async()=>{
  const f=fixture();await settle();f.feed.fire('error');assert.equal(f.timers.size,1);
  f.window.fire('pagehide');await settle();assert.equal(f.timers.size,0);assert.equal(f.feed.src,undefined);
  const starts=f.calls.filter(c=>c.body?.active).length;await f.retry();assert.equal(f.calls.filter(c=>c.body?.active).length,starts);
});
test('a lease completing after the page hides is released instead of reopening capture',async()=>{
  const f=fixture();let resolve;f.control.pendingStart=new Promise(r=>{resolve=r});await settle();
  f.document.hidden=true;f.document.fire('visibilitychange');resolve();await settle();
  assert.equal(f.feed.src,undefined);assert.equal(f.timers.size,0);assert.equal(f.calls.at(-1).body.active,false);
});
