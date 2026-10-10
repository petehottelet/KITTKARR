// Revision 13. Cache acknowledgments and synthesize answers concurrently without overlapping playback.
import {executableAvailable} from './executables.mjs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { speechConfig, streamSpeech } from '../speech.mjs';
import { transcriptionConfig, transcribeWithOpenAI } from './openai-transcription-v1.mjs';
import { AcknowledgmentCache } from './acknowledgments-v1.mjs';
import { speechChunks, playSpeechQueue } from './speech-queue-v1.mjs';
import { microphoneSource, macCaptureArgs } from './mac-input-v1.mjs';
const run=promisify(execFile);
export const sampleRate=16000;

export function pcmToWav(pcm, rate=sampleRate) {
  const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+pcm.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(rate,24);h.writeUInt32LE(rate*2,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);return Buffer.concat([h,pcm]);
}
export function pcmLevel(pcm) {
  let sum=0;const count=Math.floor(pcm.length/2);for(let i=0;i<count;i++){const v=pcm.readInt16LE(i*2)/32768;sum+=v*v;}return count?Math.sqrt(sum/count):0;
}
export function envelope(pcm, stepMs=25) {
  const size=Math.round(sampleRate*stepMs/1000)*2;const values=[];
  for(let offset=0;offset<pcm.length;offset+=size)values.push(Number(pcmLevel(pcm.subarray(offset,offset+size)).toFixed(5)));
  return {levels:values,stepMs,durationMs:pcm.length/2/sampleRate*1000};
}
export function beepPcm(index) {
  // Visible switches use keypad digits 1–8; the hidden mode switches use *, 0, #.
  const pairs=[[697,1209],[697,1336],[697,1477],[770,1209],[941,1209],[941,1336],[941,1477],[770,1336],[770,1477],[852,1209],[852,1336]];
  const [low,high]=pairs[index];
  const duration=.14;const count=Math.round(sampleRate*duration);const data=Buffer.alloc(count*2);const fade=sampleRate*.005;
  for(let i=0;i<data.length/2;i++){
    const t=i/sampleRate;const env=Math.min(1,i/fade,(count-1-i)/fade);
    const value=(Math.sin(2*Math.PI*low*t)+Math.sin(2*Math.PI*high*t))*.14*env;
    data.writeInt16LE(Math.round(value*32767),i*2);
  }return data;
}

export class AudioEngine {
  constructor({directory,serial='',spawnProcess=spawn,microphones,onLevel=()=>{},onLimit=()=>{},onPlayback=()=>{}}) {
    this.spawnProcess=spawnProcess;this.directory=directory;this.serial=serial;this.microphones=microphones;this.onLevel=onLevel;this.onLimit=onLimit;this.onPlayback=onPlayback;this.player=path.join(path.dirname(directory),'mac-player-v1');this.nativePlayer=false;
    this.adb=process.env.KITT_ADB||'adb';this.whisper=process.env.KITT_WHISPER||'whisper-cli';this.model=process.env.KITT_WHISPER_MODEL||path.join(os.homedir(),'.cache/whisper/ggml-large-v3-turbo.bin');this.ffmpeg=process.env.KITT_FFMPEG||'ffmpeg';this.volume=.7;this.capture=null;this.playback=null;this.beep=null;this.generation=0;
  }
  async initialize(){
    await mkdir(this.directory,{recursive:true,mode:0o700});try{await access(this.player,constants.X_OK);this.nativePlayer=true}catch{this.nativePlayer=false}
    this.acknowledgments=new AcknowledgmentCache({directory:path.join(this.directory,'acknowledgments')});await this.acknowledgments.load();
  }
  async warmAcknowledgments(){
    this.cacheController??=new AbortController();
    return this.acknowledgments.warm((text,file,signal)=>this.prepareVoiceClip(text,file,signal),{signal:this.cacheController.signal});
  }
  async prepareVoiceClip(text,file,signal){
    const encoded=`${file}.mp3`,raw=`${file}.pcm`;
    try{
      const stream=await streamSpeech(text,{signal});await writeFile(encoded,Buffer.from(await new Response(stream).arrayBuffer()),{mode:0o600});signal?.throwIfAborted();
      await run(this.ffmpeg,['-v','error','-i',encoded,'-ar','16000','-ac','1','-f','s16le',raw],{timeout:20000,signal});
      const pcm=await readFile(raw);signal?.throwIfAborted();await writeFile(file,pcmToWav(pcm),{mode:0o600});return envelope(pcm);
    }finally{await Promise.all([rm(encoded,{force:true}),rm(raw,{force:true})])}
  }
  acknowledge(persona){
    const clip=this.acknowledgments?.take(persona);if(!clip)return null;
    this.stopPlayback();return this.playPrepared(clip,this.generation);
  }
  async check(){
    const checkFile=async (file,mode)=>{try{await access(file,mode);return true}catch{return false}};
    const dependencies=await Promise.all([checkFile(this.model,constants.R_OK),executableAvailable(this.whisper),executableAvailable(this.ffmpeg)]);
    const config=transcriptionConfig();
    const speech=speechConfig();
    return {transcription:config.provider==='openai'?config.available&&dependencies[2]:dependencies.every(Boolean),transcriber:config.provider==='openai'?'OpenAI':'Local Whisper',transcriptionModel:config.provider==='openai'?config.model:'Whisper large-v3-turbo',speech:speech.available?speech.provider:'Mac system voice',speechModel:speech.available?speech.modelId:null,microphoneSource:microphoneSource(),microphone:microphoneSource()==='mac'?'Mac selected input':'Car Thing microphone',microphonePermission:process.env.KITT_MAC_MIC_ALLOWED==='0'?'denied':'available'};
  }
  async startCapture() {
    if(this.capture)throw new Error('The microphone is already listening.');
    if(this.microphones)return this.startRoutedCapture();
    if(microphoneSource()==='mac')return this.startMacCapture();
    this.stopPlayback();
    const id=randomUUID().replaceAll('-','');const pidFile=`/run/kitt-mic-${id}.pid`;
    const script=`echo $$ > ${pidFile}; exec arecord -q -D hw:0,0 -r 48000 -c 4 -f S32_LE -t raw -d 45 2>${pidFile}.err`;
    const child=spawn(this.adb,['-s',this.serial,'exec-out','sh','-c',script],{stdio:['ignore','pipe','pipe']});
    const capture={child,pidFile,chunks:[],bytes:0,stopping:false,closed:null};
    capture.closed=new Promise((resolve,reject)=>{
      child.on('error',()=>reject(new Error('The Car Thing microphone could not start. Check USB.')));
      child.on('close',code=>{if(code&&!capture.bytes)reject(new Error('The Car Thing microphone is unavailable. Check USB.'));else resolve();});
    });
    capture.closed.catch(()=>{});
    child.stderr.on('data',()=>{});
    let lastLevel=0;
    child.stdout.on('data',chunk=>{
      capture.bytes+=chunk.length;
      if(capture.bytes>48000*16*46){void this.stopCapture(true);return;}
      capture.chunks.push(chunk);
      if(Date.now()-lastLevel>80){lastLevel=Date.now();let sum=0,n=0;for(let i=0;i+4<=chunk.length;i+=16){sum+=(chunk.readInt32LE(i)/2147483648)**2;n++;}this.onLevel(n?Math.sqrt(sum/n):0);}
    });
    capture.timer=setTimeout(()=>this.onLimit(),45000);
    this.capture=capture;
    // Report a startup failure before claiming that the microphone is listening.
    await new Promise(r=>setTimeout(r,250));
    if(child.exitCode!==null){this.capture=null;clearTimeout(capture.timer);await capture.closed;throw new Error('The microphone stopped before recording.');}
  }
  async startRoutedCapture(){
    this.stopPlayback();
    const capture={kind:'routed',controller:new AbortController(),chunks:[],bytes:0,stopping:false};this.capture=capture;
    let lastLevel=0;
    capture.opening=this.microphones.open({signal:capture.controller.signal,onData:pcm=>{
      if(this.capture!==capture||capture.stopping)return;
      capture.bytes+=pcm.length;if(capture.bytes>sampleRate*2*46){this.onLimit();return}
      capture.chunks.push(pcm);if(Date.now()-lastLevel>80){lastLevel=Date.now();this.onLevel(pcmLevel(pcm))}
    },onError:error=>{if(this.capture!==capture)return;capture.error=error;this.onLimit()}});
    try{capture.session=await capture.opening;if(this.capture!==capture)throw new Error('Recording stopped.');capture.timer=setTimeout(()=>this.onLimit(),45000)}
    catch(error){if(this.capture===capture)await this.stopCapture(true);throw error}
  }
  async startMacCapture(){
    this.stopPlayback();
    const child=this.spawnProcess(this.ffmpeg,macCaptureArgs(45),{stdio:['ignore','pipe','pipe']});
    const capture={kind:'mac',child,chunks:[],bytes:0,stopping:false};this.capture=capture;
    let ready,failed,lastLevel=0;
    const started=new Promise((resolve,reject)=>{ready=resolve;failed=reject});
    capture.closed=new Promise(resolve=>{
      child.on('error',()=>{failed(new Error('The Mac microphone could not start. Check microphone access in System Settings.'));resolve()});
      child.on('close',()=>{failed(new Error(capture.stopping?'Recording stopped.':'The Mac microphone stopped. Check the selected input and microphone permission.'));resolve();if(!capture.stopping&&capture.bytes&&this.capture===capture)this.onLimit()});
    });
    child.stderr.on('data',()=>{});
    child.stdout.on('data',chunk=>{
      if(capture.stopping)return;
      capture.bytes+=chunk.length;if(capture.bytes>sampleRate*2*46){this.onLimit();return}
      capture.chunks.push(chunk);ready();
      if(Date.now()-lastLevel>80){lastLevel=Date.now();this.onLevel(pcmLevel(chunk))}
    });
    const startup=setTimeout(()=>failed(new Error('The Mac microphone did not provide audio. Allow microphone access and check the selected input.')),8000);
    try{await started;if(this.capture!==capture)throw new Error('Recording stopped.');capture.timer=setTimeout(()=>this.onLimit(),45000)}
    catch(error){if(this.capture===capture)await this.stopCapture(true);throw error}
    finally{clearTimeout(startup)}
  }
  async stopCapture(discard=false) {
    const capture=this.capture;if(!capture)return null;
    this.capture=null;clearTimeout(capture.timer);capture.stopping=true;
    if(capture.kind==='routed'){
      try{
        capture.controller.abort();await capture.opening.catch(()=>{});await capture.session?.stop();
        if(discard)return null;if(capture.error)throw capture.error;
        const pcm=Buffer.concat(capture.chunks);let peak=0;
        for(let i=0;i+1<pcm.length;i+=2)peak=Math.max(peak,Math.abs(pcm.readInt16LE(i)/32768));
        const gain=Math.min(capture.session.route.gain,.8/Math.max(peak,.000001));
        for(let i=0;i+1<pcm.length;i+=2)pcm.writeInt16LE(Math.round(pcm.readInt16LE(i)*gain),i);
        if(pcm.length<sampleRate*.3*2||pcmLevel(pcm)<.0008)throw new Error('I did not hear speech. Press the front button and try again.');
        return pcm;
      }finally{this.onLevel(0)}
    }
    try {
      if(capture.kind==='mac'){
        capture.child.kill('SIGINT');
        let timer;try{await Promise.race([capture.closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('The Mac microphone did not stop. Try again.')),4000)})])}finally{clearTimeout(timer)}
        if(discard)return null;
        const pcm=Buffer.concat(capture.chunks);
        if(pcm.length<sampleRate*.3*2||pcmLevel(pcm)<.0008)throw new Error('I did not hear speech. Check the selected Mac microphone and try again.');
        return pcm;
      }
      await run(this.adb,['-s',this.serial,'shell',`if [ -f ${capture.pidFile} ]; then kill -INT $(cat ${capture.pidFile}) 2>/dev/null; rm -f ${capture.pidFile} ${capture.pidFile}.err; fi`],{timeout:3000}).catch(()=>{});
      await Promise.race([capture.closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('The microphone did not stop. Reconnect USB.')),4000))]);
      if(discard)return null;
      const base=path.join(this.directory,`capture-${randomUUID()}`);let pcm;
      try{
        await writeFile(`${base}.raw`,Buffer.concat(capture.chunks),{mode:0o600});
        await run(this.ffmpeg,['-v','error','-f','s32le','-ar','48000','-ac','4','-i',`${base}.raw`,'-af','pan=mono|c0=c0','-ar','16000','-f','s16le',`${base}.pcm`],{timeout:15000});
        pcm=await readFile(`${base}.pcm`);
      }finally{await Promise.all([rm(`${base}.raw`,{force:true}),rm(`${base}.pcm`,{force:true})]);}
      if(pcm.length<sampleRate*.3*2||pcmLevel(pcm)<.0008)throw new Error('I did not hear speech. Press the dial and try again.');
      return pcm;
    }finally{capture.child.kill();this.onLevel(0);}
  }
  async transcribe(pcm) {
    if(transcriptionConfig().provider==='openai'){
      this.cancelTranscription();const controller=new AbortController();this.transcriptionController=controller;
      try{return await transcribeWithOpenAI(pcmToWav(pcm),{signal:controller.signal})}
      finally{if(this.transcriptionController===controller)this.transcriptionController=null;}
    }
    const base=path.join(this.directory,`input-${randomUUID()}`);const file=`${base}.wav`;
    try {
      await writeFile(file,pcmToWav(pcm),{mode:0o600});
      await run(this.whisper,['-m',this.model,'-f',file,'-l','en','-nt','-np','-otxt','-of',base],{timeout:90000,maxBuffer:1024*1024});
      const text=(await readFile(`${base}.txt`,'utf8')).trim();
      if(!text||/^\s*\[[\s\S]*\]\s*$/.test(text))throw new Error('No speech was recognized. Try again.');
      return text;
    }catch(error){if(error.code==='ENOENT')throw new Error('Local transcription is not installed. Check Whisper and its model path.');throw error;}
    finally{await Promise.all([rm(file,{force:true}),rm(`${base}.txt`,{force:true})]);}
  }
  cancelTranscription(){this.transcriptionController?.abort();this.transcriptionController=null;}
  stopPlayback(){this.generation++;this.speechController?.abort();this.speechController=null;this.playback?.kill();this.playback=null;this.onPlayback(null);}
  async speak(text,{beforePlayback}={}) {
    // A cached acknowledgment may already be playing. Prepare the answer now, but gate its audio.
    if(!beforePlayback)this.stopPlayback();const generation=this.generation;const controller=new AbortController();this.speechController=controller;
    const useService=speechConfig().available;const files=[];
    const chunks=useService&&process.env.KITT_SPEECH_CHUNKING!=='0'?speechChunks(text):[text.slice(0,1000)];
    try {
      await playSpeechQueue(chunks,{
        signal:controller.signal,abort:()=>controller.abort(),
        prepare:async section=>{
          const id=randomUUID(),base=path.join(this.directory,`reply-${id}`),playFile=`${base}.wav`;files.push(playFile);
          if(useService)return {id,file:playFile,waveform:await this.prepareVoiceClip(section,playFile,controller.signal)};
          const file=`${base}.aiff`,raw=`${base}.pcm`;files.push(file,raw);
          {
            await new Promise((resolve,reject)=>{
              const child=spawn('/usr/bin/say',[...(process.env.KITT_MAC_VOICE?['-v',process.env.KITT_MAC_VOICE]:[]),'-r','178','-o',file],{stdio:['pipe','ignore','pipe'],signal:controller.signal});
              const timer=setTimeout(()=>{child.kill();reject(new Error('Speech synthesis timed out.'));},45000);
              child.stderr.on('data',()=>{});child.on('error',error=>{clearTimeout(timer);reject(error)});child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('Mac speech generation failed.'))});child.stdin.end(section);
            });
          }
          controller.signal.throwIfAborted();
          await run(this.ffmpeg,['-v','error','-i',file,'-ar','16000','-ac','1','-f','s16le',raw],{timeout:20000,signal:controller.signal});
          const pcm=await readFile(raw);await writeFile(playFile,pcmToWav(pcm),{mode:0o600});
          return {id,file:playFile,waveform:envelope(pcm)};
        },
        play:async clip=>{await beforePlayback;if(generation===this.generation)await this.playPrepared(clip,generation)}
      });
    }catch(error){if(generation===this.generation)throw error;}
    finally{if(this.speechController===controller)this.speechController=null;await Promise.all(files.map(file=>rm(file,{force:true})));}
  }
  async playPrepared({id,file,waveform,kind='answer'},generation){
          if(generation!==this.generation)return;
          await new Promise((resolve,reject)=>{
            const child=spawn(this.nativePlayer?this.player:'/usr/bin/afplay',this.nativePlayer?[file,String(this.volume)]:['-v',String(this.volume),file],{stdio:this.nativePlayer?['ignore','pipe','ignore']:'ignore'});this.playback=child;
            const offset=Number(process.env.KITT_AUDIO_OFFSET_MS||0);let output='';
            if(this.nativePlayer)child.stdout.on('data',chunk=>{
              output+=chunk.toString();if(output.length>8192){child.kill();reject(new Error('The Mac playback clock stopped responding.'));return}
              let end;while((end=output.indexOf('\n'))>=0){const line=output.slice(0,end);output=output.slice(end+1);let clock;try{clock=JSON.parse(line)}catch{continue}
                if(generation!==this.generation||!Number.isFinite(clock.positionMs)||!Number.isFinite(clock.at))continue;
                this.onPlayback({id,kind,...waveform,startedAt:clock.at-clock.positionMs+offset,positionMs:clock.positionMs-offset,updatedAt:clock.at,outputLatencyMs:clock.outputLatencyMs,clock:'coreaudio'});
              }
            });
            else child.on('spawn',()=>{if(generation===this.generation)this.onPlayback({id,kind,...waveform,startedAt:Date.now()+offset,clock:'process'})});
            child.on('error',()=>reject(new Error('Mac audio playback failed. Check the selected audio device.')));
            child.on('exit',code=>{if(generation===this.generation){this.playback=null;this.onPlayback(null)}code===0||generation!==this.generation?resolve():reject(new Error('Mac audio playback stopped unexpectedly.'))});
          });
  }
  async buttonBeep(index,on) {
    this.beep?.kill();const file=path.join(this.directory,`beep-${index}-${on?'on':'off'}.wav`);
    await writeFile(file,pcmToWav(beepPcm(index)),{mode:0o600});
    const child=spawn('/usr/bin/afplay',['-v',String(this.volume*.7),file],{stdio:'ignore'});this.beep=child;child.on('error',()=>{});child.on('exit',()=>{if(this.beep===child)this.beep=null});
  }
  async close(){this.cacheController?.abort();this.cancelTranscription();this.stopPlayback();this.beep?.kill();await this.stopCapture(true);await this.acknowledgments?.warming?.catch(()=>{});}
}
