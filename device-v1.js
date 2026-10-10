// Revision 29. Top preset four opens the LCARS console from the KITT iframe.
(() => {
  'use strict';
  const $=id=>document.getElementById(id);const signal=window.KittSignal;const embedded=new URLSearchParams(location.search).get('embedded')==='1';
  const parentOrigin='http://127.0.0.1:8080';let state={phase:'connecting',volume:.7,reminders:[]};let connected=false;let pending=false;let level=0;let previous=performance.now();let serverTime=0,serverReceivedAt=0;let activeSpeech=null;let speechStarted=false;let visible=!embedded;let reminderId=null;
  const hostNow=()=>serverTime+performance.now()-serverReceivedAt;
  const wakeClient=`screen-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const listeningLight=document.querySelector('[data-switch="p4"]');
  let listeningPending=false;
  const personaSwitch=document.querySelector('[data-switch="p1"]');let personaPending=false;
  function renderPersona(){
    const on=state.persona?.michaelMode===true;
    personaSwitch.setAttribute('aria-pressed',String(on));personaSwitch.disabled=!connected||personaPending||typeof state.persona?.michaelMode!=='boolean';
    personaSwitch.title=on?'Knight Rider mode on':'Knight Rider mode off';personaSwitch.setAttribute('aria-label','P1: '+personaSwitch.title);
  }
  function renderListeningLight(){
    const now=hostNow();
    const wake=Boolean(state.wake?.active)&&now-(state.wake?.input?.updatedAt||0)<2500;
    const recording=state.phase==='listening'&&state.listenMode==='manual'&&now-(state.micUpdatedAt||0)<2500;
    const on=connected&&visible&&!document.hidden&&Boolean(state.device?.connected)&&Boolean(state.wake?.screenActive)&&(wake||recording);
    const label=on?(state.phase==='listening'?'Recording your request':'Listening for KITT or computer'):!state.wake?.enabled?'Listening off':!['idle','error','connecting'].includes(state.phase)?'Busy; press to listen':state.wake?.error?'Retry listening':'Starting listening';
    listeningLight.disabled=!connected||!visible||document.hidden||listeningPending||typeof state.wake?.enabled!=='boolean';
    listeningLight.setAttribute('aria-pressed',String(on));listeningLight.setAttribute('aria-label','P4: '+label);listeningLight.title=label;
  }
  function renewWake(){if(connected)void action('wake',{clientId:wakeClient,active:visible&&!document.hidden}).catch(()=>{})}
  const columns=[];
  for(let c=0;c<3;c++){const column=document.createElement('div');column.className='led-column';const list=[];for(let i=0;i<20;i++){const led=document.createElement('span');led.className='led';column.append(led);list.push(led)}$('led-array').append(column);columns.push(list)}
  function parentMessage(value){if(embedded)window.parent.postMessage(value,parentOrigin)}
  const ledStyles=new WeakMap();
  function paint(value){columns.forEach((column,c)=>column.forEach((led,i)=>{const v=value*(c===1?1:.76),intensity=signal.segmentIntensity(v,i),strength=intensity.toFixed(2);const old=ledStyles.get(led);if(old===strength)return;ledStyles.set(led,strength);const warm=signal.segmentColor(v,i).match(/\d+/g).map(Number);const red=[225+30*intensity,12+26*intensity,22+18*intensity];const color=red.map((channel,index)=>Math.round((channel+warm[index])/2));led.style.setProperty('--intensity',strength);led.style.setProperty('--lit',Number(strength)>0?'1':'0');led.style.setProperty('--led-color',`rgb(${color.join(',')})`)}))}
  const brain=$('thinking-brain'),brainCanvas=$('brain-mesh'),brainContext=brainCanvas.getContext('2d');
  const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
  const micWaveform=$('mic-waveform'),micCanvas=$('mic-wave'),micContext=micCanvas.getContext('2d');
  const micBars=[0,0,0];let lastMicFrame=0;
  function hideMicWave(){micWaveform.hidden=true;micBars.fill(0);lastMicFrame=0}
  function drawMicWave(now){
    const fresh=hostNow()-(state.micUpdatedAt||0)<600;
    const listening=connected&&visible&&!document.hidden&&listeningLight.getAttribute('aria-pressed')==='true'&&['idle','error','listening'].includes(state.phase)&&fresh;
    if(!listening){hideMicWave();return}
    const wasHidden=micWaveform.hidden;micWaveform.hidden=false;
    if(!micContext||!wasHidden&&now-lastMicFrame<(reducedMotion.matches?250:1000/30))return;
    const dt=lastMicFrame?Math.min((now-lastMicFrame)/1000,.1):1/30;lastMicFrame=now;
    const rms=Math.max(0,Number(state.micLevel)||0)*(state.listenMode==='manual'?10:1);
    const amplitude=Math.pow(Math.max(0,Math.min(1,(rms-.008)*6)),.6);
    // Reduced motion keeps the listening/sound distinction without continuous bar movement.
    const target=reducedMotion.matches?(amplitude>.025?.35:0):amplitude;
    micWaveform.setAttribute('aria-label',amplitude>.025?'Microphone receiving sound':'Microphone listening');
    const ctx=micContext,w=micCanvas.width,h=micCanvas.height,dot=w*6/104;
    ctx.clearRect(0,0,w,h);ctx.fillStyle='#505050';
    micBars.forEach((value,i)=>{
      const attack=[.075,.045,.06][i],release=[.15,.12,.17][i];
      const next=reducedMotion.matches?target:value+(target-value)*(1-Math.exp(-dt/(target>value?attack:release)));
      micBars[i]=next<.001?0:next;
      const height=dot+micBars[i]*(h*[.58,.82,.68][i]-dot),x=w/2+(i-1)*dot*1.85;
      ctx.beginPath();ctx.roundRect(x-dot/2,(h-height)/2,dot,height,dot/2);ctx.fill();
    });
  }
  const brainVertices=[],brainFaces=[];let brainAngle=.55,lastBrainFrame=0;
  function meshFace(a,b,c){brainFaces.push([a,b,c])}
  function brainLobe(side){
    const rings=6,slices=10,top=brainVertices.push([side*.36,-.69,0])-1;
    const start=brainVertices.length;
    for(let r=1;r<=rings;r++){
      const latitude=Math.PI*r/(rings+1),radius=Math.sin(latitude);
      for(let s=0;s<slices;s++){
        const longitude=2*Math.PI*(s+(r%2)*.23)/slices;
        const fold=1+.075*Math.sin(s*2.6+r*1.7)+.035*Math.cos(r*3-s);
        const x=side*(.36+.355*radius*Math.cos(longitude)*fold);
        const y=-.67*Math.cos(latitude)+.035*Math.sin(longitude*3+r);
        const z=.88*radius*Math.sin(longitude)*fold;
        // Taper the underside toward the brainstem and leave a central cleft.
        brainVertices.push([Math.sign(x)*Math.max(.025,Math.abs(x))*(y>.25?.9:1),y,z]);
      }
    }
    const bottom=brainVertices.push([side*.3,.64,-.06])-1;
    for(let s=0;s<slices;s++){
      meshFace(top,start+s,start+(s+1)%slices);
      for(let r=0;r<rings-1;r++){
        const a=start+r*slices+s,b=start+r*slices+(s+1)%slices,c=a+slices,d=b+slices;
        meshFace(a,b,c);meshFace(b,d,c);
      }
      meshFace(bottom,start+(rings-1)*slices+s,start+(rings-1)*slices+(s+1)%slices);
    }
  }
  brainLobe(-1);brainLobe(1);
  // A small faceted brainstem makes the rotating silhouette legible from the side.
  const stem=brainVertices.length;
  brainVertices.push([-.12,.5,-.27],[.12,.5,-.27],[.11,.56,.01],[-.11,.56,.01],[-.065,.93,-.36],[.065,.93,-.36]);
  [[0,1,2],[0,2,3],[0,4,5],[0,5,1],[1,5,2],[2,5,4],[2,4,3],[3,4,0]].forEach(face=>meshFace(...face.map(i=>stem+i)));
  function drawBrain(angle){
    const ctx=brainContext;if(!ctx)return;
    const w=brainCanvas.width,h=brainCanvas.height,scale=Math.min(w,h)*.405;
    const cos=Math.cos(angle),sin=Math.sin(angle),tilt=-.19,ct=Math.cos(tilt),st=Math.sin(tilt);
    const points=brainVertices.map(([x,y,z])=>{const rx=x*cos+z*sin,rz=z*cos-x*sin,ry=y*ct-rz*st,depth=y*st+rz*ct;const perspective=3.8/(3.8-depth);return [w/2+rx*scale*perspective,h*.45+ry*scale*perspective,depth]});
    ctx.clearRect(0,0,w,h);ctx.lineWidth=w/150;ctx.lineJoin='round';ctx.fillStyle='#000';
    const faces=brainFaces.map(face=>face.map(i=>points[i])).sort((a,b)=>a.reduce((sum,p)=>sum+p[2],0)-b.reduce((sum,p)=>sum+p[2],0));
    for(const face of faces){const depth=Math.max(0,Math.min(1,(face.reduce((sum,p)=>sum+p[2],0)/3+1)/2));const gray=Math.round(27+depth*53);ctx.strokeStyle=`rgb(${gray},${gray},${gray})`;ctx.beginPath();face.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath();ctx.fill();ctx.stroke()}
  }
  function renderThinking(){const thinking=connected&&!activeSpeech&&(['transcribing','thinking'].includes(state.phase)||(state.phase==='speaking'&&!speechStarted));if(brain.hidden===thinking){brain.hidden=!thinking;lastBrainFrame=0;if(thinking)drawBrain(brainAngle)}}
  function animate(now){
    if(!visible||document.hidden){hideMicWave();previous=now;lastBrainFrame=0;requestAnimationFrame(animate);return}
    drawMicWave(now);
    const elapsed=signal.speechPosition(activeSpeech,serverTime,serverReceivedAt,now);
    const playing=connected&&(state.phase==='speaking'||state.phase==='thinking'&&activeSpeech?.kind==='acknowledgment')&&state.audio?.speech==='voice service'&&activeSpeech&&elapsed>=0&&elapsed<activeSpeech.durationMs;
    const rms=playing?signal.speechAmplitude(activeSpeech,elapsed):0;
    const nextLevel=playing?signal.smoothSpeechLevel(level,signal.amplitudeToLevel(rms,1.2),Math.min((now-previous)/1000,.1)):0;
    previous=now;if(nextLevel!==level){level=nextLevel;paint(level)}
    if(!brain.hidden&&!reducedMotion.matches&&now-lastBrainFrame>=1000/12){if(lastBrainFrame)brainAngle+=(now-lastBrainFrame)*Math.PI*2/24000;lastBrainFrame=now;drawBrain(brainAngle)}
    requestAnimationFrame(animate);
  }
  paint(0);requestAnimationFrame(animate);
  async function action(name,body={}){
    const response=await fetch(`/api/${name}`,{method:'POST',headers:{'Content-Type':'application/json','X-KITT-Intent':'1'},body:JSON.stringify(body)});
    const value=await response.json();if(!response.ok)throw new Error(value.error||'The Mac could not complete that request.');return value;
  }
  function error(message){$('status').textContent=message;$('status').classList.add('error');$('listen-state').textContent=message;$('listen-state').title=message}
  function details(open){document.body.classList.toggle('details-open',open);$('details-toggle').setAttribute('aria-expanded',String(open));$('details-toggle').textContent=open?'Voicebox':'Details'}
  function stop(){return action('cancel').catch(e=>error(e.message))}
  async function talk(){if(!connected||!visible||document.hidden||pending)return;if(!['idle','error','listening','speaking'].includes(state.phase))return;pending=true;try{details(false);await action('wake',{clientId:wakeClient,active:true});if(state.phase==='listening')await action('listen/stop');else await action('listen/start')}catch(e){error(e.message)}finally{pending=false}}
  let replySignature=null;
  function renderReply(text){
    if(text===replySignature)return;replySignature=text;
    const element=$('reply');element.replaceChildren();let from=0;
    const links=/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g;let match;
    while((match=links.exec(text))){element.append(document.createTextNode(text.slice(from,match.index)));const a=document.createElement('a');a.textContent=match[1];a.href=match[2];a.target='_blank';a.rel='noopener noreferrer';element.append(a);from=match.index+match[0].length}
    element.append(document.createTextNode(text.slice(from)));
  }
  let connectionsSignature='';
  function render(next){
    const old=state;state=next;serverTime=next.serverTime;serverReceivedAt=performance.now();activeSpeech=next.speech||null;
    if(['speaking','thinking'].includes(old.phase)&&old.phase===next.phase&&activeSpeech&&old.speech?.id===activeSpeech.id&&old.reply===next.reply&&old.status===next.status&&old.volume===next.volume&&old.persona?.michaelMode===next.persona?.michaelMode&&old.device?.connected===next.device?.connected){renderThinking();return;}
    if(next.phase!=='speaking')speechStarted=false;else if(activeSpeech?.kind!=='acknowledgment'&&activeSpeech)speechStarted=true;
    if((!(next.phase==='speaking'||next.phase==='thinking'&&activeSpeech?.kind==='acknowledgment')||next.audio?.speech!=='voice service'||!activeSpeech)&&level!==0){level=0;paint(0)}
    renderThinking();
    renderListeningLight();
    renderPersona();
    const busy=!['idle','error'].includes(next.phase);const listening=next.phase==='listening';
    $('connection').textContent=next.device?.connected?'Car Thing connected':'Waiting for Car Thing USB';$('connection-light').classList.toggle('connected',Boolean(next.device?.connected));
    renderReply(next.replyMarkdown||next.reply||`Ready when you are, ${next.persona?.addressAs||'Driver'}.`);$('heard').hidden=!next.heard;$('heard').textContent=next.heard||'';$('status').textContent=next.status||'';$('status').classList.toggle('error',next.phase==='error');
    $('talk').disabled=!connected||!next.device?.connected||['thinking','transcribing','starting'].includes(next.phase);$('talk').classList.toggle('listening',listening);$('talk').querySelector('span').textContent=listening?'Finish speaking':next.phase==='speaking'?'Interrupt & talk':'Talk to K.I.T.T.';
    $('cancel').disabled=!busy;$('quick-stop').hidden=!busy;
    $('listen-state').disabled=$('talk').disabled;$('listen-state').classList.toggle('listening',listening);
    const labels={idle:next.wake?.active?'Say KITT or computer':'Press the front button, dial, or voicebox to talk',starting:'Opening microphone…',listening:next.listenMode==='wake'?'Listening · pause to finish':'Listening · press front button to finish',transcribing:'Recognizing your voice…',thinking:next.status||'Thinking…',speaking:'Speaking · press front button to interrupt',error:next.status||'Try again'};
    $('listen-state').textContent=labels[next.phase]||'Connecting…';
    if(document.activeElement!==$('host-volume'))$('host-volume').value=String(next.volume);$('volume-label').textContent=`${Math.round(next.volume*100)}%`;
    const nextConnections=JSON.stringify([next.audio,next.sources]);if(nextConnections!==connectionsSignature){connectionsSignature=nextConnections;
    $('connection-details').replaceChildren();
    for(const row of [{name:'Microphone',value:next.audio?.microphone||'Car Thing microphone'},{name:'Voice input',value:next.audio?.transcription?next.audio.transcriber||'Local Whisper':'Needs setup'},{name:'Voice output',value:next.audio?.speech||'Mac'},...(next.sources||[]).map(s=>({name:s.name,value:s.available?'Connected':'Unavailable'}))]){const e=document.createElement('div');e.className='connection-detail';const a=document.createElement('span'),b=document.createElement('span');a.textContent=row.name;b.textContent=row.value;e.append(a,b);$('connection-details').append(e)}
    }
    $('sources').replaceChildren();for(const source of next.links||[]){if(!/^https:\/\//.test(source.url))continue;const a=document.createElement('a');a.href=source.url;a.textContent=source.label;a.target='_blank';a.rel='noopener noreferrer';$('sources').append(a)}
    renderReminders(next.reminders||[]);
    if(next.reminderAlert&&next.reminderAlert!==reminderId){reminderId=next.reminderAlert;parentMessage({type:'kitt-reminder'});details(true);$('settings').hidden=true;$('reminder-panel').hidden=false;$('conversation-body').hidden=true}
  }
  let reminderSignature='';
  function renderReminders(items){$('reminder-count').textContent=String(items.length);const signature=JSON.stringify(items);if(signature===reminderSignature)return;reminderSignature=signature;$('reminder-list').replaceChildren();if(!items.length){const p=document.createElement('p');p.textContent='Ask K.I.T.T. to remind you about something at a specific time.';$('reminder-list').append(p)}
    for(const r of items){const item=document.createElement('div');item.className='reminder-item';const p=document.createElement('p');p.textContent=r.text;const time=document.createElement('time');time.dateTime=r.dueAt;time.textContent=new Date(r.dueAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});const dismiss=document.createElement('button');dismiss.textContent='Dismiss';dismiss.addEventListener('click',()=>void action('reminders/dismiss',{id:r.id}).catch(e=>error(e.message)));item.append(p,time,dismiss);$('reminder-list').append(item)}
  }
  let events=null,reconnectTimer=null,lastEventAt=Date.now(),leaving=false;
  function disconnected(){connected=false;activeSpeech=null;level=0;paint(0);renderThinking();renderListeningLight();renderPersona();$('talk').disabled=true;$('listen-state').disabled=true;$('connection').textContent='Mac disconnected';$('connection-light').classList.remove('connected');error('Reconnecting to Mac…')}
  function connectEvents(){
    clearTimeout(reconnectTimer);if(leaving)return;
    events?.close();lastEventAt=Date.now();
    const current=new EventSource('/api/events');events=current;
    current.onopen=()=>{if(events!==current||leaving)return;connected=true;parentMessage({type:'kitt-ready'});renewWake()};
    current.onmessage=e=>{if(events!==current||leaving)return;try{const next=JSON.parse(e.data);lastEventAt=Date.now();const first=!connected||state.phase==='connecting';connected=true;render(next);if(first)parentMessage({type:'kitt-ready'})}catch{error('The Mac sent an unreadable status. Reconnecting…')}};
    current.onerror=()=>{if(events!==current||leaving)return;disconnected();current.close();reconnectTimer=setTimeout(connectEvents,1200)};
  }
  connectEvents();
  // A terminal EventSource error or a half-open USB stream may never retry itself.
  // The host publishes a heartbeat every two seconds; recreate stale streams explicitly.
  setInterval(()=>{if(!leaving&&Date.now()-lastEventAt>6500){disconnected();connectEvents()}},2000);
  window.addEventListener('pageshow',()=>{if(leaving){leaving=false;connectEvents()}});
  let saved={};try{saved=JSON.parse(localStorage.getItem('kitt-switches')||'{}')}catch{}
  document.querySelectorAll('[data-switch]').forEach((button,index)=>{const id=button.dataset.switch;if(!['p1','p4'].includes(id)&&typeof saved[id]==='boolean')button.setAttribute('aria-pressed',String(saved[id]));button.addEventListener('click',async()=>{
    if(id==='p4'){
      if(listeningPending||!connected)return;const enabled=button.getAttribute('aria-pressed')!=='true';listeningPending=true;renderListeningLight();
      try{await action('listening',{enabled});void action('beep',{index,on:enabled}).catch(()=>{})}
      catch(e){error(e.message)}finally{listeningPending=false;renderListeningLight()}
      return;
    }
    const on=button.getAttribute('aria-pressed')!=='true';
    if(id==='p1'){
      if(personaPending||!connected)return;personaPending=true;renderPersona();
      try{await action('persona',{michaelMode:on});void action('beep',{index,on}).catch(()=>{})}
      catch(e){error(e.message)}finally{personaPending=false;renderPersona()}
      return;
    }
    button.setAttribute('aria-pressed',String(on));saved[id]=on;try{localStorage.setItem('kitt-switches',JSON.stringify(saved))}catch{}void action('beep',{index,on}).catch(()=>{});
  })});
  renderPersona();
  renderListeningLight();
  const glass=document.querySelector('.voice-window');glass.setAttribute('role','button');glass.setAttribute('tabindex','0');glass.setAttribute('aria-label','Press to start or finish talking to KITT');glass.addEventListener('click',()=>void talk());
  $('talk').addEventListener('click',()=>void talk());$('listen-state').addEventListener('click',()=>void talk());$('cancel').addEventListener('click',()=>void stop());$('quick-stop').addEventListener('click',()=>void stop());
  $('details-toggle').addEventListener('click',()=>details(!document.body.classList.contains('details-open')));
  function navigate(page){void stop();if(embedded)parentMessage({type:'kitt-navigate',page});else details(false)}$('back-to-dashboard').addEventListener('click',()=>navigate('overview'));
  $('settings-toggle').addEventListener('click',()=>{const open=$('settings').hidden;$('settings').hidden=!open;$('reminder-panel').hidden=true;$('conversation-body').hidden=open;$('settings-toggle').setAttribute('aria-expanded',String(open))});
  $('reminders-toggle').addEventListener('click',()=>{const open=$('reminder-panel').hidden;$('reminder-panel').hidden=!open;$('settings').hidden=true;$('conversation-body').hidden=open;$('reminders-toggle').setAttribute('aria-expanded',String(open))});
  $('host-volume').addEventListener('input',()=>{$('volume-label').textContent=`${Math.round(Number($('host-volume').value)*100)}%`});$('host-volume').addEventListener('change',()=>void action('volume',{volume:Number($('host-volume').value)}).catch(e=>error(e.message)));
  $('sound-test').addEventListener('click',()=>void action('voice-test').catch(e=>error(e.message)));
  $('follow-ups').addEventListener('click',()=>{details(true);$('settings').hidden=true;$('reminder-panel').hidden=true;$('conversation-body').hidden=false;void action('ask',{text:'Review recent Gmail and Slack conversations plus my upcoming Google Calendar commitments. What are the three most important work follow-ups needing my attention? Use Drive for context only when relevant. Cite the sources, be specific about who and the next step, and do not send messages or create reminders yet.'}).catch(e=>error(e.message))});
  $('text-form').addEventListener('submit',event=>{event.preventDefault();const text=$('text-input').value.trim();if(!text)return;details(true);void action('ask',{text}).then(()=>{$('text-input').value=''}).catch(e=>error(e.message))});
  let lastWheel=0;function volumeDelta(delta){void action('volume',{volume:Math.max(0,Math.min(1,state.volume+delta*.05))}).catch(e=>error(e.message))}
  window.addEventListener('wheel',event=>{if(!event.deltaX)return;event.preventDefault();if(Date.now()-lastWheel<80)return;lastWheel=Date.now();volumeDelta(Math.sign(event.deltaX))},{passive:false});
  window.addEventListener('keydown',event=>{if(/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)&&event.key!=='Escape')return;if(!['Enter',' ','Escape','Backspace','1','2','3','4','ArrowLeft','ArrowRight'].includes(event.key))return;if(event.repeat)return;event.preventDefault();if(['Enter',' ','Escape','Backspace'].includes(event.key))void talk();else if(event.key==='ArrowRight'||event.key==='ArrowLeft')volumeDelta(event.key==='ArrowRight'?1:-1);else if(event.key==='1')navigate('gallery');else if(event.key==='2')navigate('overview');else if(event.key==='3')details(false);else if(event.key==='4')navigate('lcars')});
  window.addEventListener('message',event=>{if(event.origin!==parentOrigin||event.source!==window.parent)return;if(event.data?.type==='kitt-visible'){parentMessage({type:'kitt-alive'});visible=Boolean(event.data.visible);renewWake();renderListeningLight();if(visible)window.focus()}if(event.data?.type==='kitt-volume')volumeDelta(event.data.delta===1?1:-1);if(event.data?.type==='kitt-talk')void talk()});
  setInterval(renewWake,5000);document.addEventListener('visibilitychange',()=>{renewWake();renderListeningLight()});
  setInterval(renderListeningLight,250);
  setInterval(()=>{$('clock').textContent=new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})},1000);
  window.addEventListener('pagehide',()=>{leaving=true;clearTimeout(reconnectTimer);events?.close();void fetch('/api/wake',{method:'POST',headers:{'Content-Type':'application/json','X-KITT-Intent':'1'},body:JSON.stringify({clientId:wakeClient,active:false}),keepalive:true}).catch(()=>{})});
})();
