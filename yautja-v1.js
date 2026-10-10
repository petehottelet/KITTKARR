// Revision 7. Reconnect dropped streams with deadlines and cancel on mode exit.
(() => {
  const feed=document.querySelector('#feed'),message=document.querySelector('#message'),retry=document.querySelector('#retry'),announcement=document.querySelector('#preset-announcement');
  const clientId=crypto.randomUUID();let active=false,starting=false,polling=false,timer;
  let wanted=true,reconnectTimer=null,generation=0;
  let pendingSteps=0,changing=false,selectionVersion=0;
  function showPreset(state){if(state.presetName)announcement.textContent=`${state.presetName} visual style`;}
  async function changePreset(delta){
    if(!active||document.hidden||![1,-1].includes(delta))return;
    pendingSteps=Math.max(-48,Math.min(48,pendingSteps+delta));selectionVersion++;
    if(changing)return;changing=true;
    try{
      while(active&&pendingSteps){
        const steps=pendingSteps;pendingSteps=0;
        const response=await fetch('/api/yautja/preset',{method:'POST',headers:{'Content-Type':'application/json','X-KITT-Intent':'1'},body:JSON.stringify({clientId,delta:steps}),signal:AbortSignal.timeout(3000)});
        const state=await response.json();if(!response.ok)throw Error(state.error||'Preset could not change.');
        if(active)showPreset(state);
      }
    }catch(e){pendingSteps=0;if(active)error(e.message);}finally{changing=false}
  }
  async function lease(enabled,keepalive=false){
    const response=await fetch('/api/yautja/session',{method:'POST',headers:{'Content-Type':'application/json','X-KITT-Intent':'1'},body:JSON.stringify({clientId,active:enabled}),keepalive,signal:AbortSignal.timeout(4000)});
    if(!response.ok){const body=await response.json();throw Error(body.error||'Camera could not connect.');}
  }
  function error(text){document.body.classList.remove('ready');message.textContent=text;retry.hidden=false;}
  function reconnect(text){
    if(!wanted||document.hidden)return;
    active=false;error(text);feed.removeAttribute('src');
    if(reconnectTimer===null)reconnectTimer=setTimeout(()=>{reconnectTimer=null;void open();},2000);
  }
  async function open(){
    if(starting||!wanted||document.hidden)return;
    clearTimeout(reconnectTimer);reconnectTimer=null;const token=++generation;
    starting=true;active=false;feed.removeAttribute('src');document.body.classList.remove('ready');retry.hidden=true;message.textContent='Opening the Mac camera…';
    try{
      await lease(false);if(token!==generation||!wanted||document.hidden)return;
      await lease(true);
      if(token!==generation||!wanted||document.hidden){await lease(false,true).catch(()=>{});return;}
      active=true;feed.src='/api/yautja/stream?clientId='+encodeURIComponent(clientId)+'&run='+Date.now();
    }catch(e){if(token===generation)reconnect(e.message)}finally{
      starting=false;
      if(wanted&&!active&&!document.hidden&&reconnectTimer===null)reconnect('Reconnecting the camera…');
    }
  }
  function close(){wanted=false;generation++;active=false;pendingSteps=0;clearTimeout(reconnectTimer);reconnectTimer=null;feed.removeAttribute('src');document.body.classList.remove('ready');void lease(false,true).catch(()=>{});}
  async function poll(){
    parent.postMessage({type:'yautja-heartbeat'},'http://127.0.0.1:8080');
    if(!active||document.hidden||polling)return;polling=true;
    const version=selectionVersion,token=generation;
    try{
      await lease(true);
      if(!active||token!==generation){if(!wanted)void lease(false,true).catch(()=>{});return;}
      const response=await fetch('/api/yautja/status?clientId='+encodeURIComponent(clientId),{signal:AbortSignal.timeout(4000)});
      if(!response.ok)throw Error('Camera status unavailable.');const state=await response.json();
      if(!active||token!==generation)return;
      if(!changing&&version===selectionVersion)showPreset(state);
      if(state.viewerConnected===false)reconnect('Reconnecting the camera feed…');
      else if(state.ready&&state.frameAgeMs!==null&&state.frameAgeMs<5000&&feed.naturalWidth>0){document.body.classList.add('ready');retry.hidden=true;}
      else if(state.error)error(state.error);
      else if(state.frameAgeMs!==null&&state.frameAgeMs>=5000)error('Camera feed paused. Retry to reconnect.');
    }catch{if(token===generation)reconnect('Reconnecting to your Mac…')}finally{polling=false}
  }
  feed.addEventListener('error',()=>{if(active)reconnect('Reconnecting the camera feed…')});
  retry.addEventListener('click',()=>void open());
  window.addEventListener('pagehide',()=>{clearInterval(timer);close()});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)close();else{wanted=true;void open()}});
  window.addEventListener('message',event=>{
    if(event.origin==='http://127.0.0.1:8080'&&event.source===parent&&event.data?.type==='yautja-preset')void changePreset(event.data.delta);
  });
  window.addEventListener('wheel',event=>{
    if(!Number.isFinite(event.deltaX)||event.deltaX===0)return;
    event.preventDefault();void changePreset(event.deltaX>0?1:-1);
  },{passive:false});
  window.addEventListener('keydown',event=>{
    if(['ArrowRight','ArrowLeft'].includes(event.key)){event.preventDefault();void changePreset(event.key==='ArrowRight'?1:-1);return;}
    if(event.repeat)return;
    const page={'1':'gallery','2':'overview','3':'kitt','4':'lcars','Enter':'gallery'}[event.key];
    if(page){event.preventDefault();close();parent.postMessage({type:'yautja-navigate',page},'http://127.0.0.1:8080');}
    else if(['Escape','Backspace'].includes(event.key)){event.preventDefault();close();parent.postMessage({type:'yautja-talk'},'http://127.0.0.1:8080');}
  });
  parent.postMessage({type:'yautja-heartbeat'},'http://127.0.0.1:8080');
  timer=setInterval(()=>void poll(),2000);void open();
})();
