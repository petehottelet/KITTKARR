const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {mkdtemp,mkdir,rm}=require('node:fs/promises');
const path=require('node:path'),os=require('node:os');

(async()=>{
  process.env.KITT_MODE='browser';
  const {createKittServer}=await import('../assistant/kitt-server-v1.mjs');
  const {SidePulseVoice}=await import('../assistant/sidepulse-v1.mjs');
  const browser=await chromium.launch({headless:true});
  try{
    for(const [carThing,leds,label] of [[true,false,'Car Thing'],[false,true,'Mac + SidePulse'],[true,true,'Car Thing + SidePulse']]){
      const directory=await mkdtemp(path.join(os.tmpdir(),'kitt-hardware-ui-'));
      let ready=true;const writes=[],errors=[];
      const sidePulse=new SidePulseVoice({enabled:leds,probe:async()=>({ready,code:ready?'ready':'output-disabled',message:ready?'SidePulse Pro ready. Test LEDs to check the red sweep.':'Enable device output in the SidePulse companion, then check again.'}),connect:async()=>({brightness:100,previous:'off',write:async program=>{writes.push(program);return true}})});
      const audio={initialize:async()=>{},check:async()=>({speech:'Mac system voice',microphone:'Mac selected input'}),stopPlayback(){},stopCapture:async()=>{},close:async()=>{},speak:async()=>{}};
      const assistant={initialize:async()=>[],cancel:async()=>{},close(){},ask:async()=>''};
      const wake={running:false,check:async()=>false,stop:async()=>{}};
      const bridge=carThing?{start(){this.onChange({connected:true})},stop(){}}:undefined;
      const app=await createKittServer({port:0,directory,audio,assistant,wake,bridge,sidePulse,inputMonitor:null,thinkingTone:null});
      const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',error=>errors.push(error.message));
      try{
        await app.start();await page.goto(`http://127.0.0.1:${app.port}`);
        await page.locator('#details-toggle').click();await page.locator('#settings-toggle').click();
        await page.waitForFunction(expected=>document.querySelector('#hardware-summary').textContent===expected,label);
        if(leds){
          await page.waitForFunction(()=>document.querySelector('#sidepulse-status').textContent.includes('ready'));
          await page.locator('#sidepulse-test').click();await page.waitForFunction(()=>document.querySelector('#sidepulse-test').textContent.includes('Testing'));
          assert(writes.some(program=>program.includes('#ff0000')));
          await page.waitForFunction(()=>document.querySelector('#sidepulse-test').textContent==='Test LEDs');
          assert.equal(writes.at(-1),'off');
          ready=false;await page.locator('#sidepulse-check').click();await page.waitForFunction(()=>document.querySelector('#sidepulse-status').textContent.includes('Enable device output'));
          ready=true;await page.locator('#sidepulse-check').click();await page.waitForFunction(()=>document.querySelector('#sidepulse-status').textContent.includes('ready'));
        }else assert.equal(await page.locator('#sidepulse-test').isDisabled(),true);
        assert.match(await page.locator('#connection').textContent(),carThing?/Car Thing connected/:/Mac connected/);
        if(carThing&&leds){
          await mkdir('output/qa',{recursive:true});
          for(const [name,width,height] of [['desktop',1280,900],['device',800,480],['mobile',390,844]]){
            await page.setViewportSize({width,height});await page.locator('.settings-scroll').evaluate(element=>element.scrollTop=0);
            await page.locator('#sidepulse-test').focus();await page.keyboard.press('Shift+Tab');
            assert.equal(await page.locator('#sidepulse-check').evaluate(element=>getComputedStyle(element).outlineStyle),'solid');
            assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow');
            await page.screenshot({path:`output/qa/hardware-${name}.png`,fullPage:true});
          }
          const origin=`http://127.0.0.1:${app.port}`;
          const started=await page.request.post(origin+'/api/headless',{headers:{Origin:origin,'X-KITT-Intent':'1'},data:{enabled:true}});assert.equal(started.status(),200);
          bridge.onChange({connected:false});
          await page.waitForFunction(()=>!document.querySelector('#talk').disabled);
          assert.equal(app.state().headless.enabled,true);
        }
        assert.deepEqual(errors,[]);
      }finally{await page.close();await app.close();await rm(directory,{recursive:true,force:true})}
    }
    console.log('Hardware UI passed: Car Thing, SidePulse, both, LED test/restoration, diagnostics/recovery, keyboard and responsive layouts.');
  }finally{await browser.close()}
})().catch(error=>{console.error(error.message);process.exitCode=1});
