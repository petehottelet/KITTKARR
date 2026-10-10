// Revision 2. Provide KITT name context while retaining direct-address validation.
import {executableAvailable} from './executables.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pcmToWav} from './audio-v1.mjs';
const run=promisify(execFile);
export function localWakeWord(text){
  // Require a direct address, not an incidental mention of a computer or toolkit.
  const clean=text.trim().replace(/^\[[^\]]*\]\s*/,'');
  const match=/^(?:(?:hey|okay|ok|hello)[,\s]+)?(computer|kitt?|k\.i\.t\.t\.?)\b[\s,.:;!?—-]*/i.exec(clean);
  return match?(/^computer$/i.test(match[1])?'computer':'kitt'):null;
}
export class LocalWakeVerifier {
  constructor({directory,command=process.env.KITT_WHISPER||'whisper-cli',model=process.env.KITT_WHISPER_MODEL||path.join(os.homedir(),'.cache/whisper/ggml-large-v3-turbo.bin'),onMatch=()=>{},onDiagnostic=()=>{},transcribe}={}){
    Object.assign(this,{directory,command,model,onMatch,onDiagnostic});this.transcribe=transcribe||((pcm,signal)=>this.recognize(pcm,signal));this.stopped=false;this.pending=null;this.active=null;
  }
  async check(){try{if(!await executableAvailable(this.command))return false;await access(this.model,constants.R_OK);return true}catch{return false}}
  async recognize(pcm,signal){
    await mkdir(this.directory,{recursive:true,mode:0o700});const dir=await mkdtemp(path.join(this.directory,'local-'));
    try{signal.throwIfAborted();const file=path.join(dir,'utterance.wav');await writeFile(file,pcmToWav(pcm),{mode:0o600});
      const {stdout}=await run(this.command,['-m',this.model,'-f',file,'-l','en','-nt','-np','-nf','-bo','1','-bs','1','-mc','0','--prompt','KITT (pronounced kit), computer.'],{signal,timeout:10000,maxBuffer:128*1024});
      return stdout.trim();
    }finally{await rm(dir,{recursive:true,force:true})}
  }
  offer(pcm){
    if(this.stopped||!Buffer.isBuffer(pcm)||pcm.length<16000||pcm.length>32*32000)return;
    this.pending=pcm;if(!this.active)this.drain();
  }
  drain(){
    const pcm=this.pending;if(!pcm||this.stopped)return;this.pending=null;
    const controller=new AbortController(),started=Date.now(),work={controller,done:null};this.active=work;
    work.done=(async()=>{
      let word=null;
      try{const text=await this.transcribe(pcm,controller.signal);if(!this.stopped&&!controller.signal.aborted)word=localWakeWord(text)}
      catch{if(!this.stopped&&!controller.signal.aborted)this.onDiagnostic({type:'local-wake',matched:false,error:'Local wake backup could not finish.',ms:Date.now()-started})}
      if(this.active===work)this.active=null;
      if(this.stopped||controller.signal.aborted)return;
      this.onDiagnostic({type:'local-wake',matched:!!word,ms:Date.now()-started});
      if(word){this.pending=null;this.stopped=true;this.onMatch(pcm,word)}else this.drain();
    })();
  }
  async stop(){this.stopped=true;this.pending=null;const work=this.active;work?.controller.abort();await work?.done;}
}
