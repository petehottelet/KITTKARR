// Revision 1. Browser-only layout fixtures; never imported into the device bundle.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { LcarsUsage } from '../dashboard-v1/apps/device-ui/src/screens/LcarsUsage';
import type { ProviderSnapshot } from '@carthing/contracts';
const now=Date.parse('2026-10-07T18:00:00Z');
const quota={id:'five_hour',label:'Current session',usedPercent:100,resetsAt:'2026-10-08T18:00:00Z',windowSeconds:18000};
const base:ProviderSnapshot={id:'claude',displayName:'Claude',state:'live',observedAt:new Date(now).toISOString(),source:'oauth',host:'mac',quotaWindows:[quota],tokens:{input:999000000,cachedInput:999000000,output:999000000,reasoning:999000000,total:3996000000,period:'today',periodStart:'2026-10-06'},cost:null,diagnostic:null};
const cases:Record<string,{id:'claude'|'codex';provider?:ProviderSnapshot;linkDown?:boolean}>={
  long:{id:'claude',provider:{...base,quotaWindows:[{...quota,label:'WORLDWIDE WORKSPACE WINDOW WITH WIDE WORDS AND MORE WORDS'}, {...quota,id:'seven_day',windowSeconds:604800}, {...quota,id:'extra',windowSeconds:5400}, {...quota,id:'context',windowSeconds:null,resetsAt:null,label:'Context'}]}},
  expired:{id:'claude',linkDown:true,provider:{...base,quotaWindows:[...Array.from({length:4},(_,i)=>({...quota,id:`expired-${i}`,label:`Expired window ${i+1}`,resetsAt:'2026-10-06T18:00:00Z'}))]}},
  empty:{id:'claude'},
  codex:{id:'codex',provider:{...base,id:'codex',displayName:'Codex',source:'rollout-limits',quotaWindows:[{...quota,id:'codex:primary',windowSeconds:604800}]}},
};
const host=document.createElement('div');host.id='lcars-spacing-fixture';document.body.appendChild(host);
const root=createRoot(host);
(window as any).__lcarsSpacingFixture=(name:string)=>{
  const test=cases[name];if(!test)throw Error('Unknown fixture');
  root.render(createElement(LcarsUsage,{...test,key:name,now,timeZone:'America/Los_Angeles',linkDown:test.linkDown??false,demo:true,onModeChange:()=>{}}));
};
(window as any).__lcarsSpacingCleanup=()=>{root.unmount();host.remove();delete (window as any).__lcarsSpacingFixture;delete (window as any).__lcarsSpacingCleanup;};
