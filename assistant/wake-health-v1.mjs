// Revision 2. Allow early readiness after a quarter-second of genuinely timely audio.
export class WakeHealth {
  constructor({now=()=>performance.now()}={}){
    this.now=now;this.createdAt=now();this.startedAt=null;this.bytes=0;this.decoded=0;this.lastMeter=null;this.points=[];
  }
  receive(bytes){
    if(this.startedAt===null){this.startedAt=this.now();this.points.push({at:this.startedAt,seconds:0})}
    this.bytes+=bytes;
  }
  meter(seconds){
    if(!Number.isFinite(seconds)||seconds<this.decoded)return;
    this.decoded=seconds;this.lastMeter=this.now();this.points.push({at:this.lastMeter,seconds});
    while(this.points.length>2&&this.points[1].at<this.lastMeter-4000)this.points.shift();
  }
  status(){
    const now=this.now(),first=this.points[0];
    const span=first&&this.lastMeter!==null?(this.lastMeter-first.at)/1000:0;
    const rate=span>0?(this.decoded-first.seconds)/span:null;
    const backlogSeconds=Math.max(0,this.bytes/32000-this.decoded);
    let error=null;
    if(this.lastMeter===null&&now-this.createdAt>8000)error='The wake detector did not receive usable audio.';
    else if(this.lastMeter!==null&&now-this.lastMeter>2500)error='The wake detector stopped processing audio.';
    else if(backlogSeconds>1.5)error='The wake detector fell behind the microphone.';
    else if(span>=1.5&&rate<.7)error='The microphone is delivering audio too slowly for wake detection.';
    return {active:this.decoded>=.25&&rate!==null&&rate>=.7&&!error,error,rate,backlogSeconds};
  }
}
