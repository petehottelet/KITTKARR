// Revision 6. Expose whether the requesting viewer still owns a live stream.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const presets=JSON.parse(readFileSync(new URL('./yautja-presets-v1.json',import.meta.url),'utf8')).presets;
export class YautjaCamera {
  constructor({spawnProcess=spawn,now=Date.now,leaseMs=6500}={}) {
    this.spawnProcess=spawnProcess;this.now=now;this.leaseMs=leaseMs;
    this.sessions=new Map();this.streams=new Map();this.child=null;this.frame=null;
    this.presetIndex=0;
    this.status={running:false,ready:false,frames:0,style:'Yautja default',error:null};
    this.timer=setInterval(()=>{for(const[id,expiry]of this.sessions)if(expiry<=this.now())this.release(id);},1000);
    this.timer.unref?.();
  }
  snapshot(clientId){return{...this.status,preset:presets[this.presetIndex].id,presetName:presets[this.presetIndex].name,presetIndex:this.presetIndex,presetCount:presets.length,subscribers:this.streams.size,...(clientId?{viewerConnected:this.streams.has(clientId)}:{}),lastFrameAt:this.lastFrameAt||null,frameAgeMs:this.lastFrameAt?this.now()-this.lastFrameAt:null}}
  advance(id,delta){
    if(!this.sessions.has(id)||this.sessions.get(id)<=this.now())throw Error('Open Yautja mode before changing its preset.');
    if(!Number.isInteger(delta)||delta===0||Math.abs(delta)>48)throw Error('Invalid preset direction.');
    const child=this.child;
    if(!child||child.stdin.destroyed||child.stdin.writableEnded||child.stdin.writableLength>4096)throw Error('Camera is reconnecting. Retry the dial in a moment.');
    const index=((this.presetIndex+delta)%presets.length+presets.length)%presets.length;
    child.stdin.write(JSON.stringify({preset:presets[index].id})+'\n');
    this.presetIndex=index;
    return this.snapshot();
  }
  lease(id,active){
    if(typeof id!=='string'||!/^[a-zA-Z0-9-]{10,80}$/.test(id)||typeof active!=='boolean')throw Error('Invalid camera session.');
    if(!active){this.release(id);return;}
    const entering=!this.sessions.has(id);
    if(entering&&this.sessions.size>=4)throw Error('Too many camera viewers.');
    this.sessions.set(id,this.now()+this.leaseMs);
    if(entering)this.status.error=null;
    if(!this.child&&!this.status.error)this.start();
  }
  attach(id,response){
    if(!this.sessions.has(id)||this.sessions.get(id)<=this.now())return false;
    this.streams.get(id)?.end();this.streams.set(id,response);
    response.writeHead(200,{'Content-Type':'multipart/x-mixed-replace; boundary=yautja-frame','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Accel-Buffering':'no'});
    const disconnected=()=>{if(this.streams.get(id)===response)this.release(id)};
    response.on('close',disconnected);response.on('error',disconnected);
    if(this.frame)this.send(response,this.frame);
    return true;
  }
  send(response,frame){
    if(response.destroyed||response.writableEnded||response.writableLength>256*1024)return;
    response.write(`--yautja-frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
    response.write(frame);response.write('\r\n');
  }
  start(){
    this.status={...this.status,running:true,ready:false,frames:0,error:null,appliedPreset:null};
    const child=this.spawnProcess(path.join(root,'.kitt-state/yautja-venv/bin/python'),['-u',path.join(root,'assistant/yautja-camera-v1.py'),presets[this.presetIndex].id],{cwd:root,stdio:['pipe','pipe','pipe'],detached:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
    this.child=child;let buffer=Buffer.alloc(0),errors='';
    child.stdin.on('error',()=>{if(this.child===child){this.status.error='Camera control disconnected. Retry to reconnect.';this.stop();}});
    child.stdout.on('data',chunk=>{
      if(this.child!==child)return;
      buffer=Buffer.concat([buffer,chunk]);
      while(buffer.length>=4){
        const size=buffer.readUInt32BE(0);if(size<4||size>1024*1024){this.status.error='Camera frame could not be decoded.';this.stop();return;}
        if(buffer.length<4+size)break;
        this.frame=Buffer.from(buffer.subarray(4,4+size));buffer=buffer.subarray(4+size);
        this.status.ready=true;this.status.frames++;this.lastFrameAt=this.now();
        for(const response of this.streams.values())this.send(response,this.frame);
      }
    });
    child.stderr.on('data',chunk=>{
      if(this.child!==child)return;
      errors+=chunk.toString();let newline;
      while((newline=errors.indexOf('\n'))>=0){
        const line=errors.slice(0,newline);errors=errors.slice(newline+1);
        try{const event=JSON.parse(line);if(event.version)this.status.version=event.version;if(event.error)this.status.error=event.error;if(presets.some(p=>p.id===event.preset))this.status.appliedPreset=event.preset;if(Number.isFinite(event.maskMs))this.status.maskMs=event.maskMs;if(Number.isFinite(event.personPixels))this.status.personPixels=event.personPixels;}catch{}
      }
      if(errors.length>8192)errors=errors.slice(-8192);
    });
    child.on('error',()=>{if(this.child===child){this.status.error='Yautja camera runtime is unavailable.';this.stop();}});
    child.on('exit',()=>{if(this.child===child){this.child=null;this.status.running=false;this.status.ready=false;this.frame=null;this.status.error ||= 'Camera stopped. Retry to reconnect.';}});
  }
  release(id){
    this.sessions.delete(id);const response=this.streams.get(id);this.streams.delete(id);response?.end();
    if(!this.sessions.size)this.stop();
  }
  stop(){
    const child=this.child;this.child=null;this.frame=null;this.status.running=false;this.status.ready=false;
    if(child){child.kill('SIGTERM');const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},3000);timer.unref?.();child.once('exit',()=>clearTimeout(timer));}
  }
  reset(){for(const id of [...this.sessions.keys()])this.release(id);this.stop()}
  close(){clearInterval(this.timer);this.reset()}
}
