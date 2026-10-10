// Revision 44. Report per-viewer stream health for Yautja reconnects.
import http from 'node:http';
import {ChatAssistant} from './chat-assistant.mjs';
import {hostMode, BrowserBridge} from './host-mode.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir } from 'node:fs/promises';
import { AudioEngine } from './audio-v1.mjs';
import { WorkAssistant } from './work-assistant-v1.mjs';
import { ResponsesAssistant } from './responses-assistant-v1.mjs';
import { Reminders } from './reminders-v1.mjs';
import { PersonaPreferences } from './persona-v1.mjs';
import { ListeningPreferences } from './listening-preferences-v1.mjs';
import { DeviceBridge } from './device-bridge-v1.mjs';
import { WakeListener, wakeWords, wakeCommand } from './wake-listener-v1.mjs';
import { MicrophoneRouter } from './microphone-v1.mjs';
import { MacInputMonitor } from './mac-input-v1.mjs';
import { randomUUID } from 'node:crypto';
import {ThinkingTone} from './thinking-tone-v1.mjs';
import {YautjaCamera} from './yautja-camera-v1.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
try{process.loadEnvFile(path.join(root,'.env'))}catch{}
export function trustedRequest(request,port,write=false){
  const hosts=[`127.0.0.1:${port}`,`localhost:${port}`];
  if(!hosts.includes(request.headers.host))return false;
  if(request.headers['sec-fetch-site']==='cross-site')return false;
  if(write)return hosts.some(host=>request.headers.origin===`http://${host}`)&&request.headers['x-kitt-intent']==='1'&&/^application\/json\b/.test(request.headers['content-type']||'');
  return !request.headers.origin||hosts.some(host=>request.headers.origin===`http://${host}`);
}

export function brainMode(env=process.env){
  const value=String(env.KITT_BRAIN||'chat').trim().toLowerCase();
  return value==='chat'?'chat':value==='responses'?'responses':value==='grokbot'?'grokbot':'codex';
}
export function openMicEnabled(env=process.env){
  const value=String(env.KITT_OPEN_MIC||'').trim().toLowerCase();
  return value==='1'||value==='true';
}
export function openMicSilenceMs(env=process.env){
  const raw=Number(env.KITT_OPEN_MIC_SILENCE_MS);return Number.isFinite(raw)&&raw>=400&&raw<=5000?raw:1100;
}
export function openMicSpeechFloor(env=process.env){
  const raw=Number(env.KITT_OPEN_MIC_SPEECH_FLOOR);return Number.isFinite(raw)&&raw>0&&raw<0.1?raw:0.005;
}

export function brainTimeoutMs(env=process.env){
  const value=Number(env.KITT_BRAIN_TIMEOUT_MS);
  return Number.isFinite(value)&&value>0?value:90000;
}
export function spokenAnswer(text){
  const links=[];let spoken=text.replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g,(_,label,url)=>{links.push({label,url});return label});
  spoken=spoken.replace(/https?:\/\/\S+/g,'').replace(/[*_#`]/g,'').replace(/\n[-•]\s*/g,'\n').trim();
  return {text:spoken,links};
}
export async function createKittServer({port=Number(process.env.KITT_PORT||4180),directory=process.env.KITT_STATE_DIR||path.join(root,'.kitt-state'),audio:providedAudio,assistant:providedAssistant,bridge:providedBridge,reminders:providedReminders,wake:providedWake,inputMonitor:providedInputMonitor,thinkingTone:providedThinkingTone,wakeLeaseMs=15000}={}){
  const mode=providedBridge?'carthing':hostMode();
  process.env.KITT_INPUT_SOURCE ||= mode==='browser'?'mac':'auto';
  await mkdir(directory,{recursive:true,mode:0o700});
  const camera=new YautjaCamera();
  const reminders=providedReminders||new Reminders(directory);await reminders.load();
  const persona=new PersonaPreferences(directory);await persona.load();
  const listeningPreference=new ListeningPreferences(directory);await listeningPreference.load();let listeningChanges=Promise.resolve();
  const clients=new Set();let generation=0;let closed=false;let reminderBusy=false;let turnTiming=null;let thinkingTone=null;
  const wakeClients=new Map();let wakeResumeAt=0;let wakeReconciling=false;let wakeToken=0;let brainWait=null;let openMicFailStreak=0;let openMicSession=false;let openMicSpeechSeen=false;let openMicLastVoice=0;let openMicStartedAt=0;let openMicSilenceTimer=null;
  let state={version:1,persona:persona.snapshot(),phase:'idle',listenMode:null,reply:`Ready when you are, ${persona.snapshot().addressAs}.`,heard:'',status:'Press the front button to talk.',volume:.7,micLevel:0,speech:null,sources:[],audio:{},device:{connected:false},links:[],reminderAlert:null,wake:{enabled:listeningPreference.enabled,available:false,active:false,screenActive:false,words:wakeWords,lastWord:null,error:null}};
  const activeScreen=()=>[...wakeClients.values()].some(expires=>expires>Date.now());
  const captureAllowed=()=>!closed&&state.device.connected&&activeScreen();
  const snapshot=()=>({...state,serverTime:Date.now(),reminders:reminders.list()});
  const publish=()=>{const message=`data: ${JSON.stringify(snapshot())}\n\n`;for(const response of [...clients]){try{if(response.writableEnded||response.destroyed||response.writableLength>1024*1024){clients.delete(response);response.destroy?.();continue;}response.write(message)}catch{clients.delete(response)}}};
  const update=patch=>{
    if(Object.hasOwn(patch,'reply')&&!Object.hasOwn(patch,'replyMarkdown'))patch.replyMarkdown=null;
    const at=new Date().toISOString();const events=[...(state.diagnostics||[])];
    if(patch.phase&&patch.phase!==state.phase)events.push({at,event:'phase',from:state.phase,to:patch.phase});
    if(patch.audio?.microphoneHealth&&patch.audio.microphoneHealth!==state.audio.microphoneHealth)events.push({at,event:'microphone',health:patch.audio.microphoneHealth,input:patch.audio.microphone});
    if(patch.phase==='error')patch.lastError={at,stage:state.phase,heard:state.heard,message:patch.status};
    const now=Date.now();
    if(patch.phase==='listening'&&state.phase!=='listening'||patch.phase==='thinking'&&['idle','error'].includes(state.phase))turnTiming={startedAt:now,listenMode:patch.listenMode||'text'};
    if(turnTiming){
      if(patch.heard)turnTiming.heard=patch.heard.slice(0,500);
      if(patch.phase==='transcribing')turnTiming.transcribingAt=now;
      if(patch.phase==='thinking')turnTiming.thinkingAt=now;
      if(patch.phase==='speaking')turnTiming.speakingAt=now;
      if(patch.speech&&!turnTiming.firstAudioAt){turnTiming.firstAudioAt=Math.max(now,patch.speech.startedAt);turnTiming.firstAudioMs=turnTiming.firstAudioAt-turnTiming.startedAt}
      if(patch.speech?.kind==='acknowledgment'&&!turnTiming.acknowledgmentAt){turnTiming.acknowledgmentAt=Math.max(now,patch.speech.startedAt);turnTiming.acknowledgmentMs=turnTiming.acknowledgmentAt-turnTiming.thinkingAt}
      if(patch.speech&&patch.speech.kind!=='acknowledgment'&&!turnTiming.answerFirstAudioAt){turnTiming.answerFirstAudioAt=Math.max(now,patch.speech.startedAt);turnTiming.answerFirstAudioMs=turnTiming.answerFirstAudioAt-turnTiming.startedAt}
      if(patch.phase==='idle'||patch.phase==='error'){
        turnTiming.finishedAt=now;patch.recentTurns=[...(state.recentTurns||[]),{...turnTiming,recordingMs:turnTiming.transcribingAt?turnTiming.transcribingAt-turnTiming.startedAt:null,transcriptionMs:turnTiming.thinkingAt&&turnTiming.transcribingAt?turnTiming.thinkingAt-turnTiming.transcribingAt:null,answerMs:turnTiming.speakingAt&&turnTiming.thinkingAt?turnTiming.speakingAt-turnTiming.thinkingAt:null,outcome:patch.phase}].slice(-6);turnTiming=null;
      }
    }
    state={...state,...patch,diagnostics:events.slice(-30)};thinkingTone?.setActive(state.phase==='thinking'&&!state.acknowledging&&!state.speech&&captureAllowed(),state.volume);publish();
  };
  thinkingTone=providedThinkingTone||(!providedAudio?new ThinkingTone({directory:path.join(directory,'audio')}):null);
  const microphones=!providedAudio&&!providedWake?new MicrophoneRouter({onChange:event=>{
    const selected=event.type==='selected';
    update({audio:{...state.audio,microphone:event.route?.name||'No working microphone',microphoneSource:event.route?.source||'auto',microphonePermission:'managed',microphoneAvailable:selected,microphoneFallback:!!event.fallback,microphoneHealth:event.type},wake:{...state.wake,input:null},...(['idle','error','starting'].includes(state.phase)?{status:selected?`Using ${event.route.name}. Say KITT or computer.`:event.type==='selecting'?`Checking ${event.route.name}…`:event.error||'Checking microphone fallback…'}:{})});
  }}):null;
  const clearOpenMicSilence=()=>{if(openMicSilenceTimer){clearTimeout(openMicSilenceTimer);openMicSilenceTimer=null}};
  const noteOpenMicLevel=micLevel=>{
    update({micLevel,micUpdatedAt:Date.now()});
    if(state.phase!=='listening'||state.listenMode==='wake')return;
    if(!(openMicSession||openMicEnabled()))return;
    const now=Date.now();
    const floor=openMicSpeechFloor();
    // Require a clear speech burst, not ambient hiss, before arming end-of-turn.
    if(micLevel>=Math.max(floor,0.004)){
      openMicSpeechSeen=true;openMicLastVoice=now;clearOpenMicSilence();return;
    }
    if(!openMicSpeechSeen)return;
    // Keep recording at least 1.2s after first real speech.
    if(now-openMicStartedAt<1200||now-openMicLastVoice<250)return;
    if(openMicSilenceTimer)return;
    const wait=Math.max(300,openMicSilenceMs()-(now-openMicLastVoice));
    openMicSilenceTimer=setTimeout(()=>{
      openMicSilenceTimer=null;
      if(state.phase==='listening'&&state.listenMode!=='wake'&&openMicSpeechSeen)void finishListening();
    },wait);
  };
  const audio=providedAudio||new AudioEngine({directory:path.join(directory,'audio'),serial:process.env.KITT_ADB_SERIAL||'',microphones,onLevel:noteOpenMicLevel,onLimit:()=>void finishListening(),onPlayback:speech=>update({speech})});
  await audio.initialize();state.audio=await audio.check();state.acknowledgments=audio.acknowledgments?.status();
  const assistant=providedAssistant||new (brainMode()==='chat'?ChatAssistant:brainMode()==='responses'?ResponsesAssistant:WorkAssistant)({reminders,cwd:directory,onStatus:status=>update({status})});
  update({assistant:{provider:brainMode()==='chat'?'Configured chat service':brainMode()==='responses'?'OpenAI Responses API':brainMode()==='codex'?'OpenAI/Codex':'Grok Bot bridge',model:brainMode()!=='grokbot'?assistant.model||null:null,effort:brainMode()!=='grokbot'?assistant.effort||'low':null}});
  const applyDevice=device=>{
    const wasConnected=!!state.device?.connected;
    update({device});
    if(wasConnected&&!device?.connected){
      camera.reset();
      openMicSession=false;openMicFailStreak=0;openMicSpeechSeen=false;clearOpenMicSilence();
      if(!['idle','error'].includes(state.phase))void cancel();
      return;
    }

  };
  const bridge=providedBridge||(mode==='browser'?new BrowserBridge({onChange:applyDevice}):new DeviceBridge({port,serial:process.env.KITT_ADB_SERIAL||'',onChange:applyDevice}));
  if(providedBridge)bridge.onChange=applyDevice;
  const wake=providedWake||new WakeListener({directory,serial:process.env.KITT_ADB_SERIAL||'',microphones});
  Object.assign(wake,{
    onState:active=>update({wake:{...state.wake,active:active&&captureAllowed()&&state.wake.enabled,...(active?{error:null}:{})},...(!active&&state.listenMode!=='manual'?{micLevel:0}:{})}),
    onDiagnostic:value=>update({wake:{...state.wake,...(value.type==='input'?{input:value}:value.type==='local-wake'?{localCheck:{...value,at:new Date().toISOString()}}:value.type==='endpoint'?{lastEndpoint:value}:{lastCandidate:value})}}),
    onLevel:micLevel=>{if(wake.running&&captureAllowed()&&state.wake.enabled&&(['idle','error'].includes(state.phase)||state.listenMode==='wake'))update({micLevel,micUpdatedAt:Date.now()})},
    onWake:word=>{
      if(!captureAllowed()||!state.wake.enabled||!['idle','error'].includes(state.phase))return;
      wakeToken=++generation;update({phase:'listening',listenMode:'wake',heard:'',status:'Listening. Speak your request; pause to finish.',wake:{...state.wake,lastWord:word},reminderAlert:null});
    },
    onCommand:(pcm,word)=>void finishWake(pcm,word),
    onError:error=>{wakeResumeAt=Date.now()+(microphones?500:5000);update({wake:{...state.wake,active:false,error:error.message}});if(state.listenMode==='wake')fail(error,wakeToken)},
  });
  state.wake.available=await wake.check();state.wake.localBackup=Boolean(wake.localAvailable);
  // Production omits inputMonitor: with the router active, watch the Mac default input so AirPods
  // connecting or disconnecting restarts wake/listen and re-runs routing. Tests may pass null or an object.
  const inputMonitor=providedInputMonitor===undefined&&microphones?new MacInputMonitor({mode:'airpods'}):providedInputMonitor;
  if(inputMonitor&&microphones)inputMonitor.onChange=async(input,previous)=>{
    // The router owns state.audio.microphone; never overwrite it with the Mac default name.
    // AirPods HFP profile flips the Mac default mic during playback — ignore those.
    // Only reselect when AirPods actually appear or disappear as an input device.
    if(previous===undefined)return;
    if(Boolean(previous?.airpods)===Boolean(input?.airpods))return;
    // A Bluetooth profile change must not interrupt a healthy Car Thing or Mac
    // recording. The router detects capture loss and owns fallback selection.
    if(microphones.current?.id!=='mac:'+previous?.name||!previous?.airpods||input?.airpods)return;
    if(['speaking','thinking','transcribing'].includes(state.phase))return;
    if(['starting','listening'].includes(state.phase))await cancel();
    else if(wake.running)await wake.stop();
    if(['idle','error'].includes(state.phase))update({status:input?.airpods?'AirPods connected. Preferring them for listen…':'AirPods disconnected. Falling back…'});
    void reconcileWake();
  };
  else if(inputMonitor)inputMonitor.onChange=async(input,previous)=>{
    const permitted=state.audio.microphonePermission!=='denied';
    update({audio:{...state.audio,microphone:input?.name||'No Mac microphone selected',microphoneAvailable:Boolean(input)&&permitted},...(!permitted?{status:'Allow KITT microphone access in macOS Privacy & Security settings, then restart KITT.'}:{})});
    if(previous!==undefined){
      if(['starting','listening'].includes(state.phase))await cancel();
      else if(wake.running)await wake.stop();
      if(['idle','error'].includes(state.phase))update({status:!permitted?'Allow KITT microphone access in macOS Privacy & Security settings, then restart KITT.':input?`Microphone: ${input.name}. Say KITT or computer.`:'Select an input in macOS Sound settings.'});
      void reconcileWake();
    }
  };
  async function reconcileWake(){
    if(closed)return;
    for(const [id,expires] of wakeClients)if(expires<=Date.now())wakeClients.delete(id);
    const screenActive=activeScreen();
    if(state.wake.screenActive!==screenActive)update({wake:{...state.wake,screenActive}});
    // Revocation must interrupt a pending wake.start(), not wait for it to finish.
    if(!captureAllowed()){
      openMicSession=false;clearOpenMicSilence();
      try{if(['starting','listening'].includes(state.phase))await cancel();else await wake.stop()}catch(error){wake.onError(error)}
      if(state.wake.active||state.wake.input)update({wake:{...state.wake,active:false,input:null}});
      return;
    }
    if(wakeReconciling)return;wakeReconciling=true;
    try{
      const wanted=()=>captureAllowed()&&state.wake.enabled&&state.wake.available&&(microphones||state.audio.microphoneAvailable!==false)&&((state.phase==='listening'&&state.listenMode==='wake')||(['idle','error'].includes(state.phase)&&Date.now()>=wakeResumeAt));
      if(wanted()&&!wake.running)await wake.start();
      if(!wanted()&&wake.running){if(state.listenMode==='wake')await cancel();else await wake.stop();}
    }catch(error){wake.onError(error)}finally{wakeReconciling=false}
  }
  function clearBrainWait(error){
    if(!brainWait)return null;
    clearTimeout(brainWait.timer);
    const wait=brainWait;brainWait=null;
    if(error)wait.reject(error);return wait;
  }
  function fail(error,token,{allowOpenMicRetry=false}={}){
    if(token!==undefined&&token!==generation)return;
    wakeResumeAt=Date.now()+2000;
    update({phase:'error',listenMode:null,status:error.message||'Something went wrong. Try again.',speech:null,micLevel:0});
    if(!allowOpenMicRetry||!openMicEnabled()||!openMicSession||!state.wake.enabled||!captureAllowed())return;
    openMicFailStreak+=1;
    if(openMicFailStreak>1){openMicSession=false;return;}
    const retryToken=generation;
    setTimeout(()=>{
      if(closed||retryToken!==generation||!openMicSession)return;
      if(!['idle','error'].includes(state.phase))return;
      void startListening({openMic:true}).catch(()=>{});
    },1600);
  }
  async function maybeOpenMicListen(token){
    if(token!==generation)return;
    openMicSession=false;openMicFailStreak=0;
    const ready=captureAllowed()&&state.wake.enabled&&state.wake.available;
    const status=!activeScreen()?'Open KITT mode to listen.':!state.wake.enabled?'Wake listening is off. Press P4 to listen.':!state.wake.available?'Wake-word listening needs setup. Press the front button to talk.':'Say KITT or computer, then talk. Pause when you are done.';
    wakeResumeAt=Date.now()+120;
    update({phase:'idle',listenMode:null,status});
    // Never fall back to ungated automatic recording if wake detection is unavailable.
    if(ready)setTimeout(()=>{if(token===generation&&!closed)void reconcileWake()},120);
  }
  async function speak(text,token,{beforePlayback}={}){if(token!==generation)return;update({phase:'speaking',listenMode:null,status:'Speaking through your Mac.'});await wake.stop();if(token!==generation)return;await audio.speak(text,{beforePlayback});if(token===generation)await maybeOpenMicListen(token)}
  async function ask(text,token){
    update({phase:'thinking',heard:text,status:'Working on your request…',speech:null,links:[],replyMarkdown:null});
    let acknowledgment;
    try{
      await wake.stop();if(token!==generation)return;
      // Playback starts from disk immediately. A cache miss never triggers synthesis on this path.
      if(audio.acknowledge){
        update({acknowledging:true});
        try{acknowledgment=audio.acknowledge({michaelMode:persona.michaelMode})}catch{acknowledgment=null}
        if(acknowledgment)acknowledgment=Promise.resolve(acknowledgment).catch(()=>{}).finally(()=>{if(token===generation)update({acknowledging:false})});
        else update({acknowledging:false});
      }
      const raw=await assistant.ask(text,{michaelMode:persona.michaelMode});if(token!==generation)return;
      const answer=spokenAnswer(raw);update({reply:answer.text,replyMarkdown:raw,links:answer.links,sources:assistant.sources,answerSource:assistant.lastUsage?.model||assistant.model||null});
      await speak(answer.text,token,{beforePlayback:acknowledgment});
    }catch(error){
      await acknowledgment;
      if(token!==generation)return;
      const answering=state.phase==='thinking';fail(error,token);
      if(!answering||!captureAllowed())return;
      const name=persona.snapshot().addressAs;
      const retryText=/connection|fetch failed/i.test(error.message)?`I'm sorry, ${name}, I lost the connection while answering. Please try again.`:/too long|timed out/i.test(error.message)?`I'm sorry, ${name}, that request took too long. Please try again.`:`I'm sorry, ${name}, I couldn't complete that answer. Please try again.`;
      update({reply:retryText,replyMarkdown:null,links:[]});
      try{await speak(retryText,token)}catch(playbackError){fail(playbackError,token)}
    }
  }
  async function askGrokBot(text,token){
    update({phase:'thinking',heard:text,status:'Checking with Grok Bot…',speech:null,links:[]});
    clearBrainWait(new Error('replaced'));
    const id=randomUUID();const createdAt=Date.now();
    const replyPromise=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        if(brainWait?.id!==id)return;
        brainWait=null;reject(new Error('I lost the connection to Grok Bot. Try again.'));
      },brainTimeoutMs());
      brainWait={id,text,createdAt,status:'waiting',resolve,reject,timer};
    });
    const webhook=String(process.env.KITT_GROKBOT_WEBHOOK_URL||'').trim();
    if(webhook){
      const headers={'Content-Type':'application/json'};
      const auth=String(process.env.KITT_GROKBOT_WEBHOOK_HEADER||process.env.KITT_GROKBOT_WEBHOOK_AUTH||'').trim();
      const key=String(process.env.KITT_GROKBOT_WEBHOOK_KEY||'').trim();
      if(auth){
        if(auth.includes(':')){const i=auth.indexOf(':');headers[auth.slice(0,i).trim()]=auth.slice(i+1).trim()}
        else headers.Authorization=auth;
      }else if(key){
        headers.Authorization=key.toLowerCase().startsWith('bearer ')||key.toLowerCase().startsWith('authorization')?key:`Bearer ${key}`;
      }
      const payload=JSON.stringify({type:'kitt-ask',id,text});
      const fire=async()=>{
        for(let attempt=1;attempt<=3;attempt++){
          try{
            const response=await fetch(webhook,{method:'POST',headers,body:payload,signal:AbortSignal.timeout(5000)});
            console.log(`Grok Bot webhook HTTP ${response.status} attempt=${attempt}`);
            if(response.ok)return;
          }catch(error){console.error(`Grok Bot webhook failed attempt=${attempt}: ${error.message}`)}
          await new Promise(r=>setTimeout(r,400*attempt));
        }
      };
      void fire();
      const renudge=setInterval(()=>{if(brainWait?.id!==id){clearInterval(renudge);return;}void fire();},5000);
      replyPromise.finally(()=>clearInterval(renudge));
    }
    try{
      await wake.stop();if(token!==generation){clearBrainWait(new Error('stopped'));return;}
      const result=await replyPromise;if(token!==generation)return;
      if(result?.error)throw new Error(result.error);
      const answer=spokenAnswer(result.text);update({reply:answer.text,links:answer.links});
      await speak(answer.text,token);
    }catch(error){
      if(token!==generation)return;
      if(error.message==='stopped'||error.message==='replaced'){
        wakeResumeAt=Date.now()+1500;update({phase:'idle',acknowledging:false,listenMode:null,status:'Stopped. Press the front button when you are ready.',micLevel:0,speech:null});return;
      }
      const timedOut=/lost the connection to Grok Bot/i.test(error.message||'');
      fail(error,token,{allowOpenMicRetry:timedOut||openMicSession});
    }
  }
  async function routeAsk(text,token){
    if(brainMode()!=='grokbot')return ask(text,token);
    return askGrokBot(text,token);
  }
  async function cancel(){
    generation++;wakeResumeAt=Date.now()+1500;openMicSession=false;openMicFailStreak=0;openMicSpeechSeen=false;openMicLastVoice=0;openMicStartedAt=0;clearOpenMicSilence();
    clearBrainWait(new Error('stopped'));
    audio.cancelTranscription?.();audio.stopPlayback();await Promise.all([wake.stop(),audio.stopCapture(true).catch(()=>{}),assistant.cancel()]);
    update({phase:'idle',acknowledging:false,listenMode:null,status:'Stopped. Press the front button when you are ready.',micLevel:0,speech:null});
  }
  function setListeningEnabled(enabled,{interrupt=true}={}){
    if(typeof enabled!=='boolean')return Promise.reject(new Error('Listening must be true or false.'));
    const change=listeningChanges.then(async()=>{
      if(closed)return;
      if(enabled&&!activeScreen())throw new Error('Open KITT mode before enabling the microphone.');
      if(enabled&&!state.device.connected)throw new Error('Connect the Car Thing to the Mac over USB.');
      if(enabled&&interrupt&&!state.wake.available)throw new Error('Wake-word listening needs setup before P4 can turn on.');
      await listeningPreference.setEnabled(enabled);
      update({wake:{...state.wake,enabled}});
      if(!enabled){
        openMicSession=false;clearOpenMicSilence();
        if(['starting','listening'].includes(state.phase))await cancel();else await wake.stop();
        update({wake:{...state.wake,enabled:false,active:false,input:null},...(['idle','error'].includes(state.phase)?{status:'Wake listening is off. Press P4 to listen.'}:{})});
      }else{
        // A dark P4 during a reply means "listen now": interrupt and rearm.
        if(interrupt&&!['idle','error'].includes(state.phase))await cancel();
        wakeResumeAt=0;update({...(['idle','error'].includes(state.phase)?{phase:'idle',listenMode:null,status:state.wake.available?'Starting wake listening…':'Wake-word listening needs setup. Press the front button to talk.'}:{}),wake:{...state.wake,enabled:true,error:null}});
        await reconcileWake();
      }
    });listeningChanges=change.catch(()=>{});return change;
  }
  async function startListening({openMic=false}={}){
    if(!activeScreen())throw new Error('Open KITT mode before using the microphone.');
    if(!state.device.connected)throw new Error('Connect the Car Thing to the Mac over USB.');
    if(!state.audio.transcription)throw new Error('Voice input needs setup. Check the OpenAI key or local transcription configuration on the Mac.');
    if(!microphones&&state.audio.microphonePermission==='denied')throw new Error('Allow KITT microphone access in macOS Privacy & Security settings, then restart KITT.');
    if(!microphones&&state.audio.microphoneAvailable===false)throw new Error('Select a microphone in macOS Sound settings.');
    if(!['idle','error','speaking'].includes(state.phase))throw new Error('Finish or stop the current request first.');
    await cancel();
    if(!captureAllowed())return;
    if(openMic){openMicSession=true;}
    openMicSpeechSeen=false;openMicLastVoice=0;openMicStartedAt=Date.now();clearOpenMicSilence();
    const token=++generation;update({phase:'starting',listenMode:'manual',status:'Opening microphone…',heard:'',reminderAlert:null});
    try{
      await audio.startCapture();
      if(token===generation)update({phase:'listening',status:openMic||openMicSession?'Listening. Keep talking, or press the dial to finish.':'Listening. Press the dial again to finish.'});
      else await audio.stopCapture(true);
    }catch(error){fail(error,token);throw error}
  }
  async function finishListening(){
    if(state.phase!=='listening')return;
    if(!captureAllowed()){await cancel();return}
    if(state.listenMode==='wake'){wake.finish();return;}
    const token=generation;update({phase:'transcribing',status:state.audio.transcriber==='OpenAI'?'Recognizing your voice with OpenAI…':'Recognizing your voice on the Mac…',micLevel:0});
    try{const pcm=await audio.stopCapture();if(token!==generation)return;const text=await audio.transcribe(pcm);if(token===generation)await routeAsk(text,token)}catch(error){await voiceInputFailure(error,token)}
  }
  async function finishWake(pcm){
    if(!captureAllowed()||!state.wake.enabled||state.phase!=='listening'||state.listenMode!=='wake'||wakeToken!==generation)return;
    let peak=0,sum=0;for(let i=0;i+1<pcm.length;i+=2){const v=pcm.readInt16LE(i)/32768;peak=Math.max(peak,Math.abs(v));sum+=v*v}
    const token=wakeToken;update({voiceInput:{at:new Date().toISOString(),seconds:pcm.length/32000,rms:Math.sqrt(sum/(pcm.length/2)),peak},phase:'transcribing',listenMode:null,micLevel:0,status:'Recognizing your request…'});
    try{
      await wake.stop();if(token!==generation)return;
      const transcript=await audio.transcribe(pcm);if(token!==generation)return;
      const text=wakeCommand(transcript);
      if(text===null){wakeResumeAt=Date.now()+1000;update({wake:{...state.wake,lastRejection:{at:new Date().toISOString(),reason:'No standalone wake word in transcript',transcript:transcript.slice(0,500)}},phase:'idle',status:'No standalone wake word was recognized. Say KITT or computer followed by your request.'});return;}
      if(!text){await speak(`Yes, ${persona.snapshot().addressAs}?`,token);return;}
      await routeAsk(text,token);
    }catch(error){await voiceInputFailure(error,token)}
  }
  async function voiceInputFailure(error,token){
    fail(error,token);
    if(token!==generation||!captureAllowed())return;
    const text=/No speech/.test(error.message)?`I didn't catch that, ${persona.snapshot().addressAs}. Please say KITT or computer and try again.`:'Voice input had a connection problem. Please try again.';
    update({reply:text,replyMarkdown:null,links:[]});
    try{await speak(text,token)}catch(playbackError){fail(playbackError,token)}
  }
  async function deliverReminders(){
    if(closed||reminderBusy||!['idle','error'].includes(state.phase))return;
    if(!reminders.list().some(r=>!r.announcedAt&&Date.parse(r.dueAt)<=Date.now()))return;
    reminderBusy=true;
    try{const due=await reminders.claimDue();if(!due.length)return;const token=++generation;const text=`${persona.snapshot().addressAs}, ${due.map(r=>r.text).join('. ')}`;update({reply:text,heard:'',reminderAlert:due[0].id,links:due.filter(r=>r.sourceUrl).map(r=>({label:'Reminder source',url:r.sourceUrl}))});await speak(text,token)}catch(error){fail(error)}finally{reminderBusy=false}
  }
  const publicFiles=new Map([['/assets/yautja-wordmark-v1.svg','assets/yautja-wordmark-v1.svg'],['/yautja','yautja-v1.html'],['/yautja-v1.js','yautja-v1.js'],['/yautja-v1.css','yautja-v1.css'],['/','device-v1.html'],['/device-v1.js','device-v1.js'],['/device-v1.css','device-v1.css'],['/styles.css','styles.css'],['/signal.js','signal.js'],['/assets/fonts/michroma.ttf','assets/fonts/michroma.ttf'],['/assets/icon.svg','assets/icon.svg']]);
  const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.ttf':'font/ttf','.svg':'image/svg+xml'};
  const json=(response,status,value)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(value))};
  const server=http.createServer(async(request,response)=>{
    try{
      const url=new URL(request.url,`http://127.0.0.1:${port}`);
      if(!trustedRequest(request,port,request.method==='POST')){json(response,403,{error:'Open K.I.T.T. on this Mac or the paired Car Thing.'});return;}
      if(request.method==='GET'&&url.pathname==='/api/yautja/status'){json(response,200,camera.snapshot(url.searchParams.get('clientId')));return;}
      if(request.method==='GET'&&url.pathname==='/api/yautja/stream'){if(!camera.attach(url.searchParams.get('clientId'),response))json(response,403,{error:'Open Yautja mode to start the camera.'});return;}
      if(request.method==='GET'&&url.pathname==='/api/state'){json(response,200,snapshot());return;}
      if(request.method==='GET'&&url.pathname==='/api/brain/pending'){
        if(!brainWait||brainWait.status!=='waiting'){json(response,200,{pending:null});return;}
        brainWait.status='claimed';
        json(response,200,{id:brainWait.id,text:brainWait.text,createdAt:brainWait.createdAt});return;
      }
      if(request.method==='GET'&&url.pathname==='/api/events'){
        response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Content-Type-Options':'nosniff'});response.write(`data: ${JSON.stringify(snapshot())}\n\n`);clients.add(response);request.on('close',()=>clients.delete(response));return;
      }
      if(request.method==='POST'&&url.pathname.startsWith('/api/')){
        let bytes=0;const chunks=[];for await(const chunk of request){bytes+=chunk.length;if(bytes>16384){json(response,413,{error:'Keep the request shorter.'});return}chunks.push(chunk)}
        let body;try{body=JSON.parse(Buffer.concat(chunks).toString())}catch{json(response,400,{error:'The request could not be read.'});return;}
        if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('Send a JSON object.');
        if(url.pathname==='/api/yautja/session'){
          if(body.active&&!state.device.connected)throw new Error('Connect the Car Thing before opening its camera feed.');
          camera.lease(body.clientId,body.active);
        }
        else if(url.pathname==='/api/yautja/preset'){json(response,200,camera.advance(body.clientId,body.delta));return;}
        else if(url.pathname==='/api/listening')await setListeningEnabled(body.enabled);
        else if(url.pathname==='/api/persona')update({persona:await persona.setMichaelMode(body.michaelMode)});
        else if(url.pathname==='/api/listen/start')await startListening();
        else if(url.pathname==='/api/wake'){
          if(typeof body.clientId!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(body.clientId)||typeof body.active!=='boolean')throw new Error('Invalid wake listener request.');
          for(const [id,expires] of wakeClients)if(expires<=Date.now())wakeClients.delete(id);
          const entering=body.active&&!wakeClients.has(body.clientId);
          if(body.active){if(entering&&wakeClients.size>=8)throw new Error('Too many active KITT screens.');wakeClients.set(body.clientId,Date.now()+wakeLeaseMs);}else wakeClients.delete(body.clientId);
          // Only entering arms listening; ordinary heartbeats must preserve P4 pause.
          if(entering){wakeResumeAt=0;void setListeningEnabled(true,{interrupt:false}).catch(error=>{if(activeScreen())update({wake:{...state.wake,error:error.message}})});}
          void reconcileWake();
        }
        else if(url.pathname==='/api/listen/stop'){if(state.phase!=='listening')throw new Error('The microphone is not listening.');void finishListening();}
        else if(url.pathname==='/api/cancel')await cancel();
        else if(url.pathname==='/api/ask'){
          if(typeof body.text!=='string'||!body.text.trim()||body.text.length>4000)throw new Error('Use a request between 1 and 4,000 characters.');
          if(!['idle','error'].includes(state.phase))throw new Error('Stop the current request before asking another.');
          void routeAsk(body.text.trim(),++generation);
        }
        else if(url.pathname==='/api/voice-test'){
          if(!['idle','error'].includes(state.phase))throw new Error('Stop the current request first.');
          const token=++generation;const text=`Systems online, ${persona.snapshot().addressAs}. I am listening.`;update({reply:text,heard:'',links:[]});void speak(text,token).catch(error=>fail(error,token));
        }
        else if(url.pathname==='/api/speak'){
          if(typeof body.text!=='string'||!body.text.trim()||body.text.length>4000)throw new Error('Use text between 1 and 4,000 characters.');
          if(!['idle','error','listening','speaking'].includes(state.phase))throw new Error('Stop the current request first.');
          await cancel();
          openMicSession=false; // hold always-listen until this utterance finishes
          const token=++generation;const text=body.text.trim();const answer=spokenAnswer(text);update({reply:answer.text,heard:'',links:answer.links,volume:Math.max(state.volume,.85)});
          audio.volume=Math.max(audio.volume,.85);
          void speak(answer.text,token).catch(error=>fail(error,token));
        }
        else if(url.pathname==='/api/beep'){
          if(!Number.isInteger(body.index)||body.index<0||body.index>10||typeof body.on!=='boolean')throw new Error('Unknown panel switch.');
          if(state.phase!=='listening')void audio.buttonBeep(body.index,body.on).catch(()=>{});
        }
        else if(url.pathname==='/api/volume'){
          if(typeof body.volume!=='number'||!Number.isFinite(body.volume)||body.volume<0||body.volume>1)throw new Error('Volume must be between 0 and 1.');
          audio.volume=body.volume;update({volume:body.volume});
        }
        else if(url.pathname==='/api/reminders/dismiss'){await reminders.dismiss(body.id);update({reminderAlert:null})}
        else if(url.pathname==='/api/brain/reply'){
          if(!brainWait)throw new Error('No pending Grok Bot request.');
          if(typeof body.id!=='string'||body.id!==brainWait.id)throw new Error('Unknown or stale brain request id.');
          if(typeof body.error==='string'&&body.error.trim()){
            const wait=brainWait;clearTimeout(wait.timer);brainWait=null;wait.reject(new Error(body.error.trim().slice(0,4000)));
          }else if(typeof body.text==='string'&&body.text.trim()&&body.text.length<=4000){
            const wait=brainWait;clearTimeout(wait.timer);brainWait=null;wait.resolve({text:body.text.trim()});
          }else throw new Error('Provide text (1–4000 characters) or an error message.');
        }
        else if(url.pathname==='/api/brain/cancel'){
          if(!brainWait)throw new Error('No pending Grok Bot request.');
          if(typeof body.id==='string'&&body.id&&body.id!==brainWait.id)throw new Error('Unknown or stale brain request id.');
          generation++;wakeResumeAt=Date.now()+1500;openMicSession=false;openMicFailStreak=0;
          clearBrainWait(new Error('stopped'));
          update({phase:'idle',acknowledging:false,listenMode:null,status:'Stopped. Press the front button when you are ready.',micLevel:0,speech:null});
        }
        else {json(response,404,{error:'Unknown action.'});return;}
        json(response,200,{ok:true});return;
      }
      if(request.method==='GET'&&publicFiles.has(url.pathname)){
        const file=publicFiles.get(url.pathname);const content=await readFile(path.join(root,file));response.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'self' http://127.0.0.1:8080"});response.end(content);return;
      }
      json(response,404,{error:'Not found.'});
    }catch(error){if(!response.headersSent)json(response,400,{error:error.message||'The request failed.'});else response.destroy()}
  });
  const heartbeat=setInterval(publish,2000);
  const remindersTimer=setInterval(()=>void deliverReminders(),1000);
  const wakeTimer=setInterval(()=>void reconcileWake(),250);
  return {server,get port(){return port},state:snapshot,async start(){await inputMonitor?.start();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});port=server.address().port;bridge.start();void assistant.initialize().then(sources=>update({sources})).catch(error=>update({status:`Work connection: ${error.message}`}));if(process.env.KITT_WARM_VOICE_CACHE==='1'&&audio.warmAcknowledgments)void audio.warmAcknowledgments().then(()=>{if(!closed)update({acknowledgments:audio.acknowledgments.status()})}).catch(()=>{if(!closed)update({acknowledgments:{...audio.acknowledgments.status(),error:'Some acknowledgment clips are unavailable; replies still work.'}})});return this;},async close(){closed=true;camera.close();generation++;thinkingTone?.stop();clearBrainWait(new Error('stopped'));inputMonitor?.stop();clearInterval(heartbeat);clearInterval(remindersTimer);clearInterval(wakeTimer);bridge.stop();for(const response of clients)response.end();clients.clear();assistant.close();await wake.stop();await listeningChanges;await audio.close();await new Promise(resolve=>server.close(resolve));}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await createKittServer();await app.start();console.log(`K.I.T.T. host v2 is ready at http://127.0.0.1:${app.port}`);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void app.close().then(()=>process.exit(0)));
}
