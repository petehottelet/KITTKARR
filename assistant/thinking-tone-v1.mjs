// Revision 2. Original punched-card rhythms: dry data blips, relay clicks, and varied pauses.
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pcmToWav,sampleRate} from './audio-v1.mjs';
export function thinkingPcm(variant=0){
  const pcm=Buffer.alloc(sampleRate*2*3);
  const patterns=[[840,420,1260,560,1680,420,840],[560,1120,420,840,560,1260],[1260,630,840,420,1120,560,840,420]];
  let seed=127+variant;
  for(let row=0;row<3;row++){
    const pattern=patterns[(row+variant)%patterns.length],start=.06+row*.96;
    for(let column=0;column<pattern.length;column++){
      const frequency=pattern[column],duration=column===pattern.length-1?.105:.034+(column%3)*.009;
      for(let i=0;i<duration*sampleRate;i++){
        const t=i/sampleRate,fade=Math.min(1,t/.002,(duration-t)/.005);
        // A band-limited rectangular timbre plus a tiny dry relay transient; no siren sweeps.
        const pulse=Math.sin(2*Math.PI*frequency*t)+.23*Math.sin(6*Math.PI*frequency*t)+.08*Math.sin(10*Math.PI*frequency*t);
        seed=(Math.imul(seed,1664525)+1013904223)>>>0;
        const click=(seed/4294967296*2-1)*.06*Math.exp(-t*500);
        const value=(pulse*.105+click)*fade,offset=(Math.round((start+column*.087)*sampleRate)+i)*2;
        pcm.writeInt16LE(Math.round(value*32767),offset);
      }
    }
  }return pcm;
}
export class ThinkingTone {
  constructor({directory,spawnProcess=spawn,delayMs=1200}={}){Object.assign(this,{directory,spawnProcess,delayMs});this.wanted=false;this.child=null;this.timer=null;this.generation=0;this.volume=.7;this.ready=null}
  setActive(active,volume=.7){this.volume=volume;if(active===this.wanted)return;this.stop();if(!active)return;this.wanted=true;const token=this.generation;this.timer=setTimeout(()=>void this.play(token),this.delayMs)}
  async play(token){
    if(!this.wanted||token!==this.generation)return;
    const variant=(this.sequence=(this.sequence??-1)+1)%3;
    const file=path.join(this.directory,`thinking-tones-v2-${variant}.wav`);
    try{
      this.ready??=(async()=>{await mkdir(this.directory,{recursive:true,mode:0o700});for(let i=0;i<3;i++)await writeFile(path.join(this.directory,`thinking-tones-v2-${i}.wav`),pcmToWav(thinkingPcm(i)),{mode:0o600})})();await this.ready;
      if(!this.wanted||token!==this.generation)return;
      const child=this.spawnProcess('/usr/bin/afplay',['-v',String(this.volume*.28),file],{stdio:'ignore'});this.child=child;
      const done=()=>{if(this.child===child)this.child=null;if(this.wanted&&token===this.generation)this.timer=setTimeout(()=>void this.play(token),500)};
      child.once('error',()=>{this.stop()});child.once('exit',done);
    }catch{this.ready=null;this.stop()}
  }
  stop(){this.generation++;this.wanted=false;clearTimeout(this.timer);this.timer=null;this.child?.kill();this.child=null}
}
