import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import type { ProviderSnapshot } from "@carthing/contracts";
import { cycleLcarsMode, type LcarsMode } from "../lcars/usage-v1";
import { LcarsUsage, type LcarsUsageHandle } from "./LcarsUsage";
import "./lcars-v1.css";

export interface LcarsDisplayHandle { rotate: (delta: 1 | -1) => void; activate: () => void }
interface Props { providers: ProviderSnapshot[]; now: number; timeZone: string; linkDown: boolean; demo: boolean }
export const LcarsDisplay = forwardRef<LcarsDisplayHandle,Props>(function LcarsDisplay({providers,now,timeZone,linkDown,demo}, ref) {
  const [mode,setMode]=useState<LcarsMode>("claude");
  const usage=useRef<LcarsUsageHandle>(null);
  useImperativeHandle(ref,()=>({
    rotate:(delta)=>setMode(current=>cycleLcarsMode(current,delta)),
    activate:()=>usage.current?.advance(),
  }),[]);
  return <div className="lcars-suite" data-mode={mode}>
    <LcarsUsage key={mode} ref={usage} id={mode} provider={providers.find(p=>p.id===mode)} now={now} timeZone={timeZone} linkDown={linkDown} demo={demo} onModeChange={setMode}/>
    <span className="lcars-accessible-title" role="status" aria-live="polite">{mode} usage</span>
  </div>;
});
