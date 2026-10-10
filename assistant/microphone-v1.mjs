// Revision 6. Support locking capture to the built-in computer microphone.
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {macCaptureArgs} from './mac-input-v1.mjs';
const run=promisify(execFile);
const aborted=()=>new DOMException('Microphone capture stopped.','AbortError');
export const carThingInput={id:'carthing',source:'carthing',name:'Car Thing microphone',gain:24};

export function microphoneCandidates(report={},mode='auto',macAllowed=true){
  const inputs=[];
  const visit=items=>{for(const item of items||[]){if(item.coreaudio_device_input>0)inputs.push(item);visit(item._items)}};
  visit(report.SPAudioDataType);
  const unique=[...new Map(inputs.map(item=>[item._name,item])).values()];
  const route=item=>({id:'mac:'+item._name,source:'mac',name:item._name,deviceName:item._name,gain:/airpods/i.test(item._name||'')?32:12});
  if(mode==='carthing')return [carThingInput];
  if(mode==='mac')return macAllowed?unique.filter(item=>item.coreaudio_default_audio_input_device==='spaudio_yes').map(route):[];
  const computer=unique.filter(item=>item.coreaudio_device_transport==='coreaudio_device_type_builtin');
  if(mode==='computer')return macAllowed?computer.map(route):[];
  const airpods=unique.filter(item=>/airpods/i.test(item._name)).sort((a,b)=>Number(b.coreaudio_default_audio_input_device==='spaudio_yes')-Number(a.coreaudio_default_audio_input_device==='spaudio_yes'));
  if(!macAllowed)return [carThingInput];
  return [carThingInput,...computer.map(route),...airpods.map(route)];
}

export class PcmHealth {
  constructor(){this.samples=0;this.nonzero=0;this.changes=0;this.zeroTail=0;this.constantTail=0;this.previous=null;}
  add(pcm){for(let i=0;i+1<pcm.length;i+=2){const value=pcm.readInt16LE(i);this.samples++;if(value!==0)this.nonzero++;this.zeroTail=value===0?this.zeroTail+1:0;this.constantTail=value===this.previous?this.constantTail+1:1;if(this.previous!==null&&value!==this.previous)this.changes++;this.previous=value;}}
  get ready(){return this.samples>=1600&&this.nonzero>=16&&this.changes>=2}
  get unusable(){return this.zeroTail>=16000*3||this.constantTail>=16000*3}
}

export class PcmCapture {
  constructor(route,{adb=process.env.KITT_ADB||'adb',ffmpeg=process.env.KITT_FFMPEG||'ffmpeg',serial=process.env.KITT_ADB_SERIAL||'',spawnProcess=spawn,runCommand=run,startupMs=8000,stallMs=3000,onData=()=>{},onError=()=>{}}={}){
    Object.assign(this,{route,adb,ffmpeg,serial,spawnProcess,runCommand,startupMs,stallMs,onData,onError});
    this.children=[];this.health=new PcmHealth();this.started=false;this.stopped=false;this.stopping=null;this.pending=[];this.remainder=Buffer.alloc(0);this.pidFile=null;
  }
  async start(signal){
    if(signal?.aborted)throw aborted();
    this.signal=signal;this.abort=()=>void this.stop().catch(()=>{});signal?.addEventListener('abort',this.abort,{once:true});
    const ready=new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject});
    this.lastData=Date.now();
    const fail=()=>this.fail(new Error(`${this.route.name} stopped providing audio.`));
    const child=(command,args)=>{const p=this.spawnProcess(command,args,{stdio:['pipe','pipe','pipe']});this.children.push(p);p.once('error',fail);p.once('exit',fail);p.stdin.on('error',()=>{});p.stderr.on('data',()=>{});return p};
    try{
      let output;
      if(this.route.source==='mac')output=child(this.ffmpeg,macCaptureArgs(undefined,this.route.deviceName)).stdout;
      else{
        this.pidFile=`/run/kitt-input-${randomUUID().replaceAll('-','')}.pid`;
        const convert=child(this.ffmpeg,['-v','error','-probesize','32','-analyzeduration','0','-f','s32le','-ar','48000','-ac','4','-i','pipe:0','-af','pan=mono|c0=c0','-ar','16000','-f','s16le','-flush_packets','1','pipe:1']);
        const script=`echo $$ > ${this.pidFile}; exec arecord -q -D hw:0,0 -r 48000 -c 4 -f S32_LE -t raw 2>/dev/null`;
        child(this.adb,['-s',this.serial,'exec-out','sh','-c',script]).stdout.pipe(convert.stdin);output=convert.stdout;
      }
      output.on('data',chunk=>this.receive(chunk));
      this.startup=setTimeout(()=>this.fail(new Error(`${this.route.name} did not deliver usable audio.`)),this.startupMs);
      this.watchdog=setInterval(()=>{if(this.started&&Date.now()-this.lastData>this.stallMs)fail()},250);
      await ready;
      if(this.stopped||signal?.aborted)throw aborted();
      return this;
    }catch(error){await this.stop();throw error}
  }
  receive(chunk){
    if(this.stopped)return;
    this.lastData=Date.now();
    const data=this.remainder.length?Buffer.concat([this.remainder,chunk]):chunk;
    const pcm=data.subarray(0,data.length-data.length%2);this.remainder=data.subarray(pcm.length);
    this.health.add(pcm);
    if(this.health.unusable){this.fail(new Error(`${this.route.name} is delivering silent or frozen audio.`));return}
    if(!this.started){
      this.pending.push(pcm);
      if(!this.health.ready)return;
      this.started=true;clearTimeout(this.startup);this.resolve(this);
      for(const buffered of this.pending)this.onData(buffered);this.pending=[];
    }else this.onData(pcm);
  }
  fail(error){
    if(this.stopped)return;
    const active=this.started;
    this.reject?.(error);
    void this.stop().catch(()=>{}).then(()=>{if(active&&!this.signal?.aborted)this.onError(error)});
  }
  async stop(){
    if(this.stopping)return this.stopping;
    this.stopped=true;clearTimeout(this.startup);clearInterval(this.watchdog);this.signal?.removeEventListener('abort',this.abort);this.reject?.(aborted());this.pending=[];
    this.stopping=(async()=>{
      const exits=this.children.map(child=>child.exitCode!==null||child.signalCode!==null?Promise.resolve():new Promise(resolve=>child.once('close',resolve)));
      for(const child of this.children){child.stdout.unpipe();child.kill('SIGINT');}
      if(this.pidFile){
        const script=`if [ -f ${this.pidFile} ]; then pid=$(cat ${this.pidFile}); kill -INT "$pid" 2>/dev/null; n=0; while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 40 ]; do sleep 0.05; n=$((n+1)); done; if kill -0 "$pid" 2>/dev/null; then exit 1; fi; rm -f ${this.pidFile}; fi`;
        await this.runCommand(this.adb,['-s',this.serial,'shell',script],{timeout:3500}).catch(()=>{});
      }
      let timer;try{await Promise.race([Promise.all(exits),new Promise(resolve=>{timer=setTimeout(resolve,2000)})])}finally{clearTimeout(timer);for(const child of this.children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}
    })();
    return this.stopping;
  }
}

export class MicrophoneRouter {
  constructor({mode=process.env.KITT_INPUT_SOURCE||'auto',onChange=()=>{},read=async()=>JSON.parse((await run('/usr/sbin/system_profiler',['SPAudioDataType','-json'],{timeout:4000,maxBuffer:1024*1024})).stdout),createCapture=(route,callbacks)=>new PcmCapture(route,callbacks),now=Date.now,cooldownMs=30000,macAllowed=process.env.KITT_MAC_MIC_ALLOWED!=='0'}={}){
    Object.assign(this,{mode,onChange,read,createCapture,now,cooldownMs,macAllowed});this.failed=new Map();this.current=null;
  }
  async open({onData=()=>{},onError=()=>{},signal}={}){
    let report={};if(this.mode!=='carthing'&&this.macAllowed)try{report=await this.read()}catch{}
    if(signal?.aborted)throw aborted();
    const candidates=microphoneCandidates(report,this.mode,this.macAllowed);
    const ready=candidates.filter(route=>(this.failed.get(route.id)||0)<=this.now());
    const ordered=ready.length?ready:candidates;
    const failures=[];
    for(const route of ordered){
      if(signal?.aborted)throw aborted();
      this.onChange({type:'selecting',route});
      const failed=error=>{this.failed.set(route.id,this.now()+this.cooldownMs);this.current=null;this.onChange({type:'failed',route,error:error.message});};
      const capture=this.createCapture(route,{onData,onError:error=>{failed(error);onError(error)}});
      try{
        await capture.start(signal);
        if(signal?.aborted){await capture.stop();throw aborted()}
        this.current=route;this.failed.delete(route.id);this.onChange({type:'selected',route,fallback:this.mode==='auto'&&route.id!==candidates[0]?.id});
        return capture;
      }catch(error){
        await capture.stop();
        if(signal?.aborted||error.name==='AbortError')throw aborted();
        failed(error);failures.push(route.name);
      }
    }
    this.onChange({type:'unavailable'});
    throw new Error(failures.length?`No working microphone. Tried ${failures.join(', ')}.`:'No permitted microphone is available. Check microphone access and USB.');
  }
}
