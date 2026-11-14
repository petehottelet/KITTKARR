const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {mkdtemp,mkdir,rm}=require('node:fs/promises');
const os=require('node:os'),path=require('node:path');

(async()=>{
  const {createKittServer}=await import('../assistant/kitt-server-v1.mjs');
  const directory=await mkdtemp(path.join(os.tmpdir(),'kitt-settings-ui-'));
  const audio={initialize:async()=>{},check:async()=>({speech:'local',microphone:'Example microphone'}),stopPlayback(){},stopCapture:async()=>{},close:async()=>{},speak:async()=>{}};
  const assistant={initialize:async()=>[],cancel:async()=>{},close(){},ask:async()=>''};
  const wake={running:false,check:async()=>false,stop:async()=>{}};
  const app=await createKittServer({port:0,directory,audio,assistant,wake,inputMonitor:null,thinkingTone:null});
  let browser;
  try{
    await app.start();browser=await chromium.launch({headless:true});
    const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${app.port}`);
    await page.locator('#details-toggle').click();await page.locator('#settings-toggle').click();
    await page.waitForFunction(()=>!document.querySelector('#voice-effects').disabled);
    await page.locator('#effects-enabled').check();await page.locator('#effects-filter').selectOption('robot');await page.locator('#effects-robot').selectOption('digital');await page.locator('#effects-space').selectOption('small_room');
    await page.locator('#effects-mix').fill('0.65');await page.locator('#effects-apply').focus();await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('#effects-status').textContent.includes('Settings saved'));
    assert.equal(app.state().effects.filter,'robot');assert.equal(app.state().effects.wetMix,0.65);assert.equal(app.state().phase,'idle');
    await page.reload();await page.locator('#details-toggle').click();await page.locator('#settings-toggle').click();
    await page.waitForFunction(()=>document.querySelector('#effects-filter').value==='robot');
    assert.equal(await page.locator('#effects-robot').inputValue(),'digital');assert.equal(await page.locator('#effects-mix').inputValue(),'0.65');
    await mkdir('output/qa',{recursive:true});
    for(const [name,width,height] of [['desktop',1280,900],['device',800,480],['mobile',390,844]]){
      await page.setViewportSize({width,height});await page.locator('.settings-scroll').evaluate(element=>{element.scrollTop=document.querySelector('#voice-effects').offsetTop-element.offsetTop});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow');
      for(const id of ['effects-apply','effects-status'])assert(await page.locator('#'+id).evaluate(element=>{const r=element.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight}),'Save and status remain visible');
      await page.locator('#sound-test').focus();await page.keyboard.press('Shift+Tab');
      assert.equal(await page.locator('#effects-apply').evaluate(element=>document.activeElement===element),true);
      assert.equal(await page.locator('#effects-apply').evaluate(element=>getComputedStyle(element).outlineStyle),'solid');
      await page.screenshot({path:`output/qa/voice-effects-${name}.png`,fullPage:true});
    }
    await page.route('**/api/effects',route=>route.fulfill({status:400,json:{error:'Example save failure.'}}));
    await page.locator('#effects-gain').fill('0.8');await page.locator('#effects-apply').click();
    await page.waitForFunction(()=>document.querySelector('#effects-status').textContent.includes('Try Apply effects again'));
    assert.equal(await page.locator('#effects-gain').inputValue(),'0.8');assert.equal(await page.locator('#voice-effects').isDisabled(),false);
    // Keep the simulated event connection open while the animation advances.
    await page.addInitScript(state=>{
      window.EventSource=class{
        constructor(){this.timer=setInterval(()=>{
          const now=Date.now(),provider=decodeURIComponent(location.hash.slice(1));
          this.onmessage?.({data:JSON.stringify({...state,serverTime:now,phase:'speaking',audio:{...state.audio,speech:provider},speech:{id:'example-waveform',startedAt:now,stepMs:25,durationMs:30000,levels:Array(1200).fill(0.4)}})});
        },100)}
        close(){clearInterval(this.timer)}
      };
    },app.state());
    for(const provider of ['local','Mac system voice']){
      await page.goto(`http://127.0.0.1:${app.port}/#${encodeURIComponent(provider)}`);await page.reload();
      await page.waitForFunction(()=>[...document.querySelectorAll('.led')].some(element=>Number(element.style.getPropertyValue('--intensity'))>0));
    }
    assert.deepEqual(errors,[]);console.log('Device settings passed: keyboard save, persistence, error recovery, responsive layouts, local/system speech waveforms.');
  }finally{await browser?.close();await app.close();await rm(directory,{recursive:true,force:true})}
})().catch(error=>{console.error(error.message);process.exitCode=1});
