// Revision 1. Persist whether P4 has enabled continuous wake-word listening.
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';

export class ListeningPreferences {
  constructor(directory,{enabled=process.env.KITT_WAKE_ENABLED!=='0'}={}){this.file=path.join(directory,'listening-v1.json');this.version=1;this.enabled=enabled;this.queue=Promise.resolve()}
  async load(){
    await mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
    try{const value=JSON.parse(await readFile(this.file,'utf8'));if(!Number.isInteger(value.version)||value.version<1||typeof value.enabled!=='boolean')throw Error('Invalid listening settings.');this.version=value.version;this.enabled=value.enabled}
    catch(error){if(error.code!=='ENOENT')throw error}
  }
  setEnabled(enabled){
    if(typeof enabled!=='boolean')return Promise.reject(Error('Listening must be true or false.'));
    const save=this.queue.then(async()=>{
      const next={version:this.version+1,enabled};
      await writeFile(this.file+'.tmp',JSON.stringify(next),{mode:0o600});await rename(this.file+'.tmp',this.file);
      this.version=next.version;this.enabled=enabled;return enabled;
    });this.queue=save.catch(()=>{});return save;
  }
}
