// Revision 16. Surface command endpoint timing without recording microphone audio.
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import { microphoneSource, macCaptureArgs } from './mac-input-v1.mjs';
import { WakeHealth } from './wake-health-v1.mjs';
import { LocalWakeVerifier } from './local-wake-v1.mjs';
const run=promisify(execFile);
const root=fileURLToPath(new URL('../',import.meta.url));
export const wakeWords=['kitt','computer'];
const wakePattern='(?:computer|kitt?|k\\.i\\.t\\.t\\.?)\\b[\\s,.:;!?—-]*';
export function stripWakeWord(text){return text.trim().replace(new RegExp('^(?:(?:hey|okay|ok|hello)[,\\s]+)?'+wakePattern,'i'),'').trim();}
export function wakeCommand(text){
  // A phonetic candidate such as "computerized" must not submit a request.
  const match=new RegExp('\\b'+wakePattern,'i').exec(text);
  return match?text.slice(match.index+match[0].length).trim():null;
}

export class WakeListener {
  constructor({directory=path.join(root,'.kitt-state'),serial='',microphones,keywords=path.join(root,'assistant/wake-keywords-v4.txt'),onState=()=>{},onWake=()=>{},onCommand=()=>{},onLevel=()=>{},onError=()=>{},onDiagnostic=()=>{}}={}){
    this.python=process.env.KITT_WAKE_PYTHON||path.join(directory,'wake-venv/bin/python');
    this.models=process.env.KITT_WAKE_MODELS||path.join(directory,'wake-models');
    this.adb=process.env.KITT_ADB||'adb';this.ffmpeg=process.env.KITT_FFMPEG||'ffmpeg';
    Object.assign(this,{serial,microphones,keywords,onState,onWake,onCommand,onLevel,onError,onDiagnostic});this.session=null;this.stopping=null;this.generation=0;this.localDirectory=path.join(directory,'wake-temp');this.localAvailable=false;
  }
  async check(){try{await access(this.python,constants.X_OK);await access(this.ffmpeg,constants.X_OK);await access(path.join(this.models,'silero_vad.onnx'));const folder=path.join(this.models,'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20');for(const file of ['tokens.txt',...['encoder','decoder','joiner'].map(name=>`${name}-epoch-13-avg-2-chunk-8-left-64${name==='decoder'?'':'.int8'}.onnx`)])await access(path.join(folder,file));await run(this.python,['-c','import sherpa_onnx, numpy'],{timeout:5000});this.localAvailable=process.env.KITT_WAKE_FALLBACK!=='0'&&await new LocalWakeVerifier({directory:this.localDirectory}).check();return true}catch{return false}}
  get running(){return Boolean(this.session)}
  async start(){
    if(this.session)return;const token=++this.generation;await this.stopping;if(token!==this.generation||this.session)return;
    let mac=microphoneSource()==='mac';
    const session={children:[],createdAt:Date.now(),pidFile:mac||this.microphones?null:`/run/kitt-wake-${randomUUID().replaceAll('-','')}.pid`,ready:false,received:false,active:false,awake:false,delivered:false};
    this.session=session;
    const failed=error=>{if(this.session!==session||session.delivered)return;void this.stop().catch(()=>{});this.onError(error instanceof Error?error:new Error(mac?'The Mac wake microphone stopped. Check the selected input and microphone permission; retrying automatically.':'Wake-word microphone stopped. Check USB; retrying automatically.'))};
    const child=(command,args)=>{const p=spawn(command,args,{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,PYTHONUNBUFFERED:'1'}});session.children.push(p);p.on('error',failed);p.on('exit',failed);p.stdin.on('error',()=>{});p.stderr.on('data',()=>{});return p;};
    let worker;const pending=[];
    const feed=pcm=>{
      if(this.session!==session)return;
      session.health??=new WakeHealth();session.health.receive(pcm.length);session.received=true;
      if(worker)worker.stdin.write(pcm);else pending.push(pcm);
    };
    if(this.microphones){
      session.controller=new AbortController();
      session.opening=this.microphones.open({signal:session.controller.signal,onData:feed,onError:failed});
      try{session.capture=await session.opening;if(this.session!==session){await session.capture.stop();return}mac=session.capture.route.source==='mac';session.received=true}
      catch(error){if(this.session!==session)return;await this.stop();throw error}
    }
    if(this.localAvailable){session.local=new LocalWakeVerifier({directory:this.localDirectory,onDiagnostic:value=>{if(this.session===session)this.onDiagnostic(value)},onMatch:(pcm,word)=>{
      if(this.session!==session||session.awake||session.delivered)return;
      session.awake=true;session.delivered=true;this.onWake(word);this.onCommand(pcm,word);
    }})}
    const wakeGain=process.env.KITT_WAKE_GAIN||session.capture?.route?.gain||(mac?12:24);worker=child(this.python,[path.join(root,'assistant/wake-worker-v1.py'),'--models',this.models,'--keywords',this.keywords,'--gain',String(wakeGain),...(session.local?['--local-fallback']:[])]);session.worker=worker;
    session.health??=new WakeHealth();
    const active=()=>{
      if(this.session!==session||session.delivered)return;
      const health=session.health.status();
      if(health.error){failed(new Error(health.error+' Retrying automatically.'));return}
      const enabled=session.ready&&session.received&&health.active;
      if(enabled!==session.active){session.active=enabled;this.onState(enabled)}
    };
    session.watchdog=setInterval(active,250);
    let output='';
    worker.stdout.on('data',chunk=>{
      if(this.session!==session)return;output+=chunk.toString();if(output.length>2*1024*1024){failed();return}
      let end;while((end=output.indexOf('\n'))>=0){const line=output.slice(0,end);output=output.slice(end+1);let event;try{event=JSON.parse(line)}catch{failed();return}
        if(event.event==='ready'){session.ready=true;active()}
        if(event.event==='utterance'&&!session.awake&&typeof event.pcm==='string')session.local?.offer(Buffer.from(event.pcm,'base64'));
        if(event.event==='candidate')this.onDiagnostic({keyword:event.keyword,recentSpeech:event.recentSpeech,utteranceOffset:event.utteranceOffset,accepted:event.accepted,reason:event.reason});
        if(event.event==='endpoint')this.onDiagnostic({type:'endpoint',reason:event.reason,recordingSeconds:event.recordingSeconds,trailingSeconds:event.trailingSeconds,vadSpeaking:event.vadSpeaking,foreground:event.foreground});
        if(event.event==='meter'){
          session.health.meter(event.seconds);active();if(this.session!==session)return;
          this.onDiagnostic({type:'input',updatedAt:Date.now(),seconds:event.seconds,rms:event.rms,gain:event.gain,capturedSeconds:session.health.bytes/32000,queuedBytes:worker.stdin.writableLength,elapsedSeconds:(Date.now()-session.createdAt)/1000,...session.health.status()});
        }
        if(event.event==='wake'&&wakeWords.includes(event.keyword)&&!session.awake){session.awake=true;void session.local?.stop();this.onWake(event.keyword)}
        if(event.event==='level'&&Number.isFinite(event.value))this.onLevel(Math.max(0,Math.min(1,event.value)));
        if(event.event==='command'&&session.awake&&!session.delivered&&typeof event.pcm==='string'){
          const pcm=Buffer.from(event.pcm,'base64');if(pcm.length<3200||pcm.length>16000*2*33){failed();return}
          session.delivered=true;this.onCommand(pcm,event.keyword);
        }
      }
    });
    if(this.microphones){for(const pcm of pending)worker.stdin.write(pcm);pending.length=0;}
    else if(mac){
      const capture=child(this.ffmpeg,macCaptureArgs());capture.stdout.on('data',feed);
    }else{
      const convert=child(this.ffmpeg,['-v','error','-probesize','32','-analyzeduration','0','-f','s32le','-ar','48000','-ac','4','-i','pipe:0','-af','pan=mono|c0=c0','-ar','16000','-f','s16le','-flush_packets','1','pipe:1']);
      convert.stdout.on('data',feed);
      const script=`echo $$ > ${session.pidFile}; exec arecord -q -D hw:0,0 -r 48000 -c 4 -f S32_LE -t raw 2>/dev/null`;
      const capture=child(this.adb,['-s',this.serial,'exec-out','sh','-c',script]);capture.stdout.pipe(convert.stdin);
    }
    const started=Date.now();while(this.session===session&&!(session.ready&&session.received)&&Date.now()-started<12000)await new Promise(r=>setTimeout(r,50));
    if(this.session===session&&!(session.ready&&session.received)){await this.stop();throw new Error(mac?'The Mac wake detector did not start. Check the selected microphone and access permission.':'Local wake detector did not start. Check its installation and USB.');}
  }
  finish(){if(!this.session?.awake)throw new Error('No wake-word request is recording.');this.session.worker.kill('SIGUSR1');}
  async stop(){
    this.generation++;
    if(this.stopping)return this.stopping;const session=this.session;if(!session)return;
    this.session=null;clearInterval(session.watchdog);this.onState(false);this.onLevel(0);
    this.stopping=(async()=>{
      const exits=session.children.map(child=>child.exitCode!==null||child.signalCode!==null?Promise.resolve():new Promise(resolve=>child.once('close',resolve)));
      for(const child of session.children){child.stdout.unpipe();child.kill();}
      const localDone=session.local?.stop();
      if(session.controller){session.controller.abort();await session.opening.catch(()=>{});await session.capture?.stop();}
      await localDone;
      if(!session.pidFile){let timer;try{await Promise.race([Promise.all(exits),new Promise(resolve=>{timer=setTimeout(resolve,2000)})])}finally{clearTimeout(timer);for(const child of session.children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}return}
      // Sending the signal alone returns before ALSA releases the microphone.
      const stop=`if [ -f ${session.pidFile} ]; then pid=$(cat ${session.pidFile}); kill -INT "$pid" 2>/dev/null; n=0; while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 40 ]; do sleep 0.05; n=$((n+1)); done; if kill -0 "$pid" 2>/dev/null; then exit 1; fi; rm -f ${session.pidFile}; fi`;
      try{await run(this.adb,['-s',this.serial,'shell',stop],{timeout:3500})}
      catch{throw new Error('The wake microphone did not release. Check USB and try again.')}
    })();
    try{await this.stopping}finally{this.stopping=null}
  }
}
