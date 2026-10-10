// Revision 4. Recognize the built-in computer-only capture mode.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run=promisify(execFile);

export function microphoneSource(env=process.env){return ['mac','computer'].includes(env.KITT_INPUT_SOURCE)?'mac':'carthing'}
export function macCaptureArgs(seconds,device='default'){return ['-hide_banner','-loglevel','error','-nostdin','-probesize','32','-analyzeduration','0','-f','avfoundation','-i','none:'+device,...(seconds?['-t',String(seconds)]:[]),'-ar','16000','-ac','1','-f','s16le','-flush_packets','1','pipe:1']}
export function selectedMacInput(report){
  const visit=items=>{for(const item of items||[]){if(item.coreaudio_default_audio_input_device==='spaudio_yes')return {name:item._name||'Mac microphone',sampleRate:Number(item.coreaudio_device_srate)||null};const nested=visit(item._items);if(nested)return nested}return null};
  return visit(report.SPAudioDataType);
}
export function airpodsConnected(report){
  const visit=items=>{for(const item of items||[]){if(item.coreaudio_device_input>0&&/airpods/i.test(item._name||''))return true;if(visit(item._items))return true}return false};
  return visit(report.SPAudioDataType);
}
export function macInputSnapshot(report){
  const input=selectedMacInput(report);
  return {name:input?.name||null,sampleRate:input?.sampleRate||null,airpods:airpodsConnected(report)};
}
export class MacInputMonitor {
  constructor({onChange=()=>{},read=async()=>JSON.parse((await run('/usr/sbin/system_profiler',['SPAudioDataType','-json'],{timeout:4000,maxBuffer:1024*1024})).stdout),mode='default'}={}){this.onChange=onChange;this.read=read;this.mode=mode;this.current=undefined;this.running=false;this.closed=false;this.timer=null;}
  async check(){
    if(this.running||this.closed)return;this.running=true;
    try{
      const report=await this.read();
      const input=this.mode==='airpods'?macInputSnapshot(report):selectedMacInput(report);
      if(!this.closed&&JSON.stringify(input)!==JSON.stringify(this.current)){const previous=this.current;this.current=input;await this.onChange(input,previous)}
    }catch{}finally{this.running=false}
  }
  async start(){await this.check();if(!this.closed)this.timer=setInterval(()=>void this.check(),2500)}
  stop(){this.closed=true;clearInterval(this.timer)}
}
