// Revision 1. Generate missing short phrases once in the configured voice service voice, without playback.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AudioEngine} from '../assistant/audio-v1.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
try{process.loadEnvFile(path.join(root,'.env'))}catch{}
const audio=new AudioEngine({directory:path.join(process.env.KITT_STATE_DIR||path.join(root,'.kitt-state'),'audio')});
try{
  await audio.initialize();await audio.warmAcknowledgments();
  const status=audio.acknowledgments.status();
  console.log(JSON.stringify({...status,clips:[...audio.acknowledgments.clips.values()].map(c=>({text:c.text,durationMs:c.waveform.durationMs}))}));
  if(status.ready!==status.total)process.exitCode=1;
}finally{await audio.close()}
