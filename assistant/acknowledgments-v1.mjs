// Revision 1. Reusable voice service acknowledgments, keyed by voice settings and kept off the request path.
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {speechConfig,voiceSettings} from '../speech.mjs';

export const acknowledgmentPhrases={
  normal:['Let me check.', 'One moment.', "I'll look into that.", 'Let me work that out.', 'Give me a moment.', "I'm on it.", 'Let me see.', "I'll check that for you."],
  michael:['One moment, Michael.', 'Let me check, Michael.', 'Stand by, Michael.', 'Processing your request, Michael.'],
};
export function acknowledgmentProfile(env=process.env){
  const {available,voiceId,modelId,provider,endpoint}=speechConfig(env);
  return {available,voiceId,modelId,provider,endpointHash:createHash('sha256').update(endpoint).digest('hex'),settings:voiceSettings(env)};
}
export class AcknowledgmentCache {
  constructor({directory,profile=acknowledgmentProfile(),random=Math.random}){
    Object.assign(this,{directory,profile,random});this.clips=new Map();this.bags=new Map();this.last=null;this.warming=null;
    // Never include credentials in cache metadata, filenames, or logs.
    this.key=createHash('sha256').update(JSON.stringify({version:2,provider:profile.provider,endpointHash:profile.endpointHash,voiceId:profile.voiceId,modelId:profile.modelId,settings:profile.settings})).digest('hex').slice(0,20);
  }
  paths(text){const id=createHash('sha256').update(text).digest('hex').slice(0,16),base=path.join(this.directory,`${this.key}-${id}`);return {file:`${base}.wav`,metadata:`${base}.json`}}
  async read(text){
    const {file,metadata}=this.paths(text),[wav,json]=await Promise.all([readFile(file),readFile(metadata,'utf8')]);
    const data=JSON.parse(json),w=data.waveform;
    if(data.key!==this.key||data.text!==text||!w||w.stepMs!==25||!Number.isFinite(w.durationMs)||w.durationMs<=0||w.durationMs>6000||!Array.isArray(w.levels)||w.levels.length!==Math.ceil(w.durationMs/25)||!w.levels.every(n=>Number.isFinite(n)&&n>=0&&n<=1)||!w.levels.some(n=>n>0)||wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE'||wav.readUInt32LE(24)!==16000||wav.readUInt16LE(22)!==1||wav.readUInt16LE(34)!==16||Math.abs(wav.length-44-w.durationMs*32)>1)throw Error('Invalid acknowledgment cache');
    const clip={text,file,waveform:w};this.clips.set(text,clip);return clip;
  }
  async load(){
    if(!this.profile.available)return;
    await mkdir(this.directory,{recursive:true,mode:0o700});
    await Promise.all(Object.values(acknowledgmentPhrases).flat().map(text=>this.read(text).catch(()=>{})));
  }
  warm(generate,{signal}={}){
    if(this.warming)return this.warming;
    this.warming=this.fill(generate,signal).finally(()=>{this.warming=null});return this.warming;
  }
  async fill(generate,signal){
    if(!this.profile.available)return;
    await this.load();
    for(const text of Object.values(acknowledgmentPhrases).flat()){
      signal?.throwIfAborted();if(this.clips.has(text))continue;
      const {file,metadata}=this.paths(text),temporary=`${file}.${randomUUID()}.tmp`,json=`${temporary}.json`;
      try{
        const waveform=await generate(text,temporary,signal);signal?.throwIfAborted();
        await writeFile(json,JSON.stringify({version:1,key:this.key,text,waveform}),{mode:0o600});
        await rename(temporary,file);await rename(json,metadata);await this.read(text);
      }finally{await Promise.all([rm(temporary,{force:true}),rm(json,{force:true})])}
    }
  }
  take({michaelMode=false}={}){
    const mode=michaelMode?'michael':'normal',available=acknowledgmentPhrases[mode].filter(text=>this.clips.has(text));
    if(!available.length)return null;
    let bag=this.bags.get(mode)||[];
    if(!bag.length){
      bag=[...available];for(let i=bag.length-1;i>0;i--){const j=Math.floor(this.random()*(i+1));[bag[i],bag[j]]=[bag[j],bag[i]]}
      if(bag.length>1&&bag.at(-1)===this.last)[bag[0],bag[bag.length-1]]=[bag.at(-1),bag[0]];
      this.bags.set(mode,bag);
    }
    const text=bag.pop();this.last=text;return {...this.clips.get(text),id:randomUUID(),kind:'acknowledgment'};
  }
  status(){return {ready:this.clips.size,total:Object.values(acknowledgmentPhrases).flat().length}}
}
