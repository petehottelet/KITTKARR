// Revision 3. Verify exact short durations in the rendered Claude instrument too.
import { describe, it, expect } from "vitest";
import type { ProviderSnapshot, QuotaWindow } from "@carthing/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LcarsDisplay } from "../dashboard-v1/apps/device-ui/src/screens/LcarsDisplay";
import { LcarsUsage } from "../dashboard-v1/apps/device-ui/src/screens/LcarsUsage";
import { cycleLcarsMode, quotaPeriodLabel, quotaReading, usageView } from "../dashboard-v1/apps/device-ui/src/lcars/usage-v1";
const now=Date.parse("2026-10-07T18:00:00Z");
const zone="America/Los_Angeles";
const window:QuotaWindow={id:"five_hour",label:"Current session",usedPercent:0,resetsAt:"2026-10-07T21:00:00Z",windowSeconds:18000};
const provider:ProviderSnapshot={id:"claude",displayName:"Claude",state:"live",observedAt:new Date(now).toISOString(),source:"oauth",host:"mac",quotaWindows:[window],tokens:null,cost:null,diagnostic:null};
describe("LCARS usage",()=>{
  it("opens Claude usage and exposes only the two usage modes",()=>{
    const markup=renderToStaticMarkup(createElement(LcarsDisplay,{providers:[],now,timeZone:zone,linkDown:false,demo:false}));
    expect(markup).toContain('data-mode="claude"');
    expect(markup).toContain("CLAUDE USAGE");expect(markup).toContain("CODEX USAGE");
    expect(markup.toLowerCase()).not.toContain("screensaver");expect(markup).not.toContain("lcars-scene");
  });
  it("keeps short and long quota windows distinct",()=>{
    expect(quotaPeriodLabel(18000,"Weekly")).toBe("5 HOUR PERIOD");
    expect(quotaPeriodLabel(604800,"Current")).toBe("7 DAY PERIOD");
    expect(quotaPeriodLabel(null,"Context")).toBe("CONTEXT");
    expect(quotaPeriodLabel(900,"Current")).toBe("15 MINUTE PERIOD");
    expect(quotaPeriodLabel(5400,"Current")).toBe("90 MINUTE PERIOD");
    expect(quotaPeriodLabel(91,"Current")).toBe("91 SECOND PERIOD");
  });
  it("renders Claude short windows without rounding their durations",()=>{
    const markup=renderToStaticMarkup(createElement(LcarsUsage,{id:"claude",now,timeZone:zone,linkDown:false,demo:false,onModeChange:()=>{},provider:{...provider,quotaWindows:[{...window,id:"quarter",label:"Quarter hour",windowSeconds:900},{...window,id:"ninety",label:"Ninety minutes",windowSeconds:5400}]}}));
    expect(markup).toContain("15 MINUTE PERIOD");expect(markup).toContain("90 MINUTE PERIOD");expect(markup).not.toContain("0H WINDOW");expect(markup).not.toContain("2H WINDOW");
  });
  it("renders unavailable and disconnected status without synthetic usage",()=>{
    const props={id:"claude" as const,now,timeZone:zone,linkDown:false,demo:false,onModeChange:()=>{}};
    const empty=renderToStaticMarkup(createElement(LcarsUsage,props));
    expect(empty).toContain("LIMITS NOT REPORTED");expect(empty).toContain("UNAVAILABLE");expect(empty).toContain("NO HISTORY REPORTED");
    const stale=renderToStaticMarkup(createElement(LcarsUsage,{...props,provider,linkDown:true}));
    expect(stale).toContain("STALE");expect(stale).toContain('data-used="0"');
  });
  it("cycles modes in order and wraps in both directions",()=>{

    expect(cycleLcarsMode("claude",1)).toBe("codex");
    expect(cycleLcarsMode("codex",1)).toBe("claude");
    expect(cycleLcarsMode("claude",-1)).toBe("codex");
    expect(cycleLcarsMode("codex",-1)).toBe("claude");
  });
  it("distinguishes reported zero from missing data",()=>{
    expect(quotaReading(window,now).used).toBe(0);
    expect(quotaReading(window,now).remaining).toBe(100);
    expect(quotaReading({...window,usedPercent:null},now).used).toBeNull();
    const view=usageView(undefined,"claude",now,zone,false);
    expect(view.state).toBe("unavailable");expect(view.total).toBe("—");expect(view.quotas).toEqual([]);
  });
  it("does not present an expired allowance as current usage or fresh capacity",()=>{
    const reading=quotaReading({...window,usedPercent:94,resetsAt:new Date(now-1).toISOString()},now);
    expect(reading.used).toBeNull();expect(reading.remaining).toBeNull();expect(reading.reset).toContain("AWAITING UPDATE");
  });
  it("exposes stale and disconnected observations",()=>{
    expect(usageView(provider,"claude",now,zone,true).state).toBe("stale");
    expect(usageView({...provider,observedAt:new Date(now-3600000).toISOString()},"claude",now,zone,false).state).toBe("stale");
  });
  it("keeps missing historical days unknown and genuine zero visible",()=>{
    const view=usageView({...provider,history:[{date:"2026-10-06",total:0},{date:"2026-10-07",total:25}]},"claude",now,zone,false);
    expect(view.days.slice(0,5).every(d=>d.value===null)).toBe(true);
    expect(view.days[5]?.value).toBe(0);expect(view.days[6]?.value).toBe(25);
  });
  it("labels an old token bucket by date instead of today",()=>{
    const view=usageView({...provider,tokens:{input:1,cachedInput:2,output:3,reasoning:null,total:6,period:"today",periodStart:"2026-10-06"}},"claude",now,zone,false);
    expect(view.period).toBe("2026-10-06");expect(view.total).toBe("6");expect(view.channels[3]?.value).toBe("—");
  });
});
