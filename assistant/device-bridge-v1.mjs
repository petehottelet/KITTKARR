// Revision 5. Verify explicit HTTP success on firmware without remote exit codes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const run=promisify(execFile);
export class DeviceBridge {
  constructor({serial='',port=4180,onChange=()=>{},deploy=process.env.KITT_DEPLOY_UI==='1',runner=run}={}){this.serial=serial;this.port=port;this.adb=process.env.KITT_ADB||'adb';this.onChange=onChange;this.running=false;this.connected=false;this.timer=null;this.deploy=deploy;this.lastCheck=0;this.runner=runner;}
  async command(args,timeout=5000){return this.runner(this.adb,['-s',this.serial,...args],{timeout,maxBuffer:1024*1024});}
  async probe(){
    // This firmware's legacy ADB shell exits zero even when wget fails.
    const {stdout}=await this.command(['shell',`wget -q -T 3 -O /dev/null http://127.0.0.1:${this.port}/api/yautja/status && echo KITT_HTTP_OK`],4000);
    if(!stdout.split(/\r?\n/).includes('KITT_HTTP_OK'))throw new Error('The device cannot reach the KITT host.');
  }
  async ensureDashboard(){
    const dist=fileURLToPath(new URL('../dashboard-v1/apps/device-ui/dist/',import.meta.url));
    const index=await readFile(path.join(dist,'index.html'));
    const hash=createHash('sha256').update(index).digest('hex');
    const {stdout}=await this.command(['shell','cat /run/claudething-ui/kitt-v1.sha256 2>/dev/null']);
    if(stdout.trim()===hash)return;
    const identity=await this.command(['shell',"grep -qx 'ID=claudething' /etc/os-release && test -d /run/claudething-ui && echo KITT_READY"]);
    if(!identity.stdout.includes('KITT_READY'))throw new Error('The expected ClaudeThing dashboard is not ready.');
    await this.command(['push',path.join(dist,'assets'),'/run/claudething-ui/'],30000);
    await this.command(['push',path.join(dist,'index.html'),'/run/claudething-ui/.kitt-index-next'],10000);
    const promoted=await this.command(['shell',`set -e; mv /run/claudething-ui/.kitt-index-next /run/claudething-ui/index.html; echo ${hash} > /run/claudething-ui/kitt-v1.sha256; systemctl restart chromium-kiosk.service; echo KITT_DEPLOYED`],15000);
    if(!promoted.stdout.includes('KITT_DEPLOYED'))throw new Error('The dashboard update could not be activated.');
  }
  async tick(){
    if(this.running)return;this.running=true;
    try {
      const {stdout}=await this.command(['get-state'],3000);
      if(stdout.trim()!=='device')throw new Error('USB disconnected.');
      if(this.deploy&&(!this.connected||Date.now()-this.lastCheck>60000)){await this.ensureDashboard();this.lastCheck=Date.now();}
      try{await this.probe();}catch{
        await this.command(['reverse',`tcp:${this.port}`,`tcp:${this.port}`],3000);
        await this.probe();
      }
      this.connected=true;
    }catch{this.connected=false}finally{this.running=false;this.onChange({connected:this.connected,serial:this.serial});}
  }
  start(){void this.tick();this.timer=setInterval(()=>void this.tick(),10000)}
  stop(){clearInterval(this.timer)}
}
