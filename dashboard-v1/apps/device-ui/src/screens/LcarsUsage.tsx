// Revision 5. Put the mode hint in the header to leave a separate bottom control band.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ProviderSnapshot } from "@carthing/contracts";
import { formatTokens } from "../components/Meter";
import { LCARS_MODES, type LcarsMode, quotaPeriodLabel, usageView } from "../lcars/usage-v1";
import "./lcars-usage-v1.css";

interface Props {
  id: "claude" | "codex";
  provider?: ProviderSnapshot;
  now: number;
  timeZone: string;
  linkDown: boolean;
  demo: boolean;
  onModeChange: (mode: LcarsMode) => void;
}
export interface LcarsUsageHandle { advance: () => void }
const colors = { ground:"#000000", structure:"#ff9966", secondary:"#ffcc66", interactive:"#cc99cc", data:"#99ccff", text:"#ede7db", bright:"#ffff99" };
const C=colors;
const LABELS:Record<LcarsMode,string>={claude:"CLAUDE USAGE",codex:"CODEX USAGE"};
function QuotaLabel({x,y,width,label}:{x:number;y:number;width:number;label:string}) {
  const ref=useRef<SVGTextElement>(null);
  const [visible,setVisible]=useState(label);
  useEffect(()=>{
    let cancelled=false;
    const fit=()=>{
      const el=ref.current;
      if(cancelled||!el)return;
      // Measure the actual bundled font; reserve the percentage lane even for long names.
      el.textContent=label;
      let end=label.length;
      while(end>0&&el.getComputedTextLength()>width){end--;el.textContent=label.slice(0,end)+'…';}
      const fitted=el.textContent||label;
      el.textContent=visible;
      setVisible(fitted);
    };
    fit();document.fonts.ready.then(fit);
    return()=>{cancelled=true;};
  },[label,width,visible]);
  return <g><title>{label}</title><text ref={ref} x={x} y={y} fontSize="18" fill={C.text} data-text-width={width}>{visible}</text></g>;
}
function Frame({codex}:{codex:boolean}) {
  // Both elbow cutouts and the vertical segments use the same 34px rail.
  const rail=34, fill=codex?C.data:C.structure;
  return <g aria-hidden="true" transform={codex?"translate(792 8) scale(-1 1)":"translate(8 8)"}>
    <path d={`M38 0H784V13H58Q${rail} 13 ${rail} 37V51H0V38Q0 0 38 0Z`} fill={fill}/>
    <rect y="54" width={rail} height="139" fill={fill}/><rect y="196" width={rail} height="116" fill={C.secondary}/><rect y="315" width={rail} height="105" fill={C.interactive}/>
    <path d={`M0 423H${rail}V434Q${rail} 450 53 450H784V464H28Q0 464 0 436Z`} fill={fill}/>
  </g>;
}
function Heading({x,y,width,label}:{x:number;y:number;width:number;label:string}) {
  return <g><rect x={x} y={y-12} width="5" height="14" fill={C.interactive}/><text x={x+12} y={y} fontSize="15" fill={C.interactive}>{label}</text><path d={`M${x} ${y+9}H${x+width}`} stroke={C.interactive} strokeWidth="2"/></g>;
}
function Segments({x,y,width,value}:{x:number;y:number;width:number;value:number|null}) {
  return <g aria-hidden="true">{Array.from({length:30},(_,i)=>{
    const cell=width/30, portion=value===null?0:Math.max(0,Math.min(1,value/100*30-i));
    return <g key={i}><rect x={x+i*cell} y={y} width={cell-3} height="10" fill={C.data} opacity=".19"/>{portion>0&&<rect x={x+i*cell} y={y} width={(cell-3)*portion} height="10" fill={C.secondary}/>}</g>;
  })}</g>;
}

export const LcarsUsage=forwardRef<LcarsUsageHandle,Props>(function LcarsUsage({id,provider,now,timeZone,linkDown,demo,onModeChange},ref){
  const [quotaPage,setQuotaPage]=useState(0);
  const view=usageView(provider,id,now,timeZone,linkDown);
  const codex=id==="codex", x=codex?24:66, right=codex?465:500, rightWidth=codex?274:260;
  const perPage=codex?2:4, pageCount=Math.max(1,Math.ceil(view.quotas.length/perPage));
  const page=quotaPage%pageCount;
  const advance=()=>setQuotaPage(current=>(current+1)%pageCount);
  useImperativeHandle(ref,()=>({advance}));
  const shown=view.quotas.slice(page*perPage,(page+1)*perPage);
  const limitWidth=386;
  const status=demo?"DEMO DATA":view.state==="live"?view.source:view.state.toUpperCase();
  const historyMax=Math.max(1,...view.days.map(day=>day.value??0));
  const showEmpty=shown.length===0;
  return <main className={`lcars-mode lcars-usage lcars-usage-${id}`} data-provider={id} data-state={view.state} aria-label={`${id} LCARS usage`}>
    <h1 className="lcars-accessible-title">{LABELS[id]}</h1>
    <svg viewBox="0 0 800 480" preserveAspectRatio="none" role="img" aria-labelledby="lcars-usage-title lcars-usage-description">
      <title id="lcars-usage-title">{LABELS[id]}</title>
      <desc id="lcars-usage-description">{status}. Observed {view.age.toLowerCase()}. {view.quotas.map(q=>`${q.label}: ${q.used===null?"not available":q.used+" percent used"}. ${q.reset}.`).join(" ")} Recorded tokens {view.period.toLowerCase()}: {view.total}.</desc>
      <g fontFamily="Antonio, sans-serif" fontWeight="400">
        <rect width="800" height="480" fill={C.ground}/><Frame codex={codex}/>
        <text x={x} y="64" fontSize="31" fill={C.bright}>{LABELS[id]}</text>
        <text x={x+220} y="59" fontSize="11" fill={C.interactive}>{pageCount>1?`LIMIT BANK ${page+1} / ${pageCount} · TAP OR PRESS DIAL FOR MORE`:demo?"DEMONSTRATION DATA":"USAGE TELEMETRY / TURN DIAL TO SWITCH MODE"}</text>
        <text x={codex?739:760} y="48" fontSize="16" fill={view.state==="live"?C.data:C.secondary} textAnchor="end">{status}</text>
        <text x={codex?739:760} y="68" fontSize="11" fill={C.text} textAnchor="end">{view.age==="NEVER"?"WAITING FOR FIRST OBSERVATION":`OBSERVED ${view.age}`}</text>
        <Heading x={x} y={96} width={limitWidth} label={codex?"ACCOUNT CAPACITY / USED":"LIMIT WINDOWS / USED"}/>
        {showEmpty&&<g>
          <text x={x} y="166" fontSize="29" fill={C.secondary}>LIMITS NOT REPORTED</text>
          <text x={x} y="195" fontSize="15" fill={C.text}>{provider?"AVAILABLE TOKEN DATA IS SHOWN AT RIGHT":"WAITING FOR THE MAC COLLECTOR"}</text>
          <path d={`M${x} 221H${x+limitWidth}M${x} 250H${x+limitWidth}M${x} 279H${x+limitWidth}`} stroke={C.interactive} opacity=".35"/>
        </g>}
        {!codex&&shown.map((q,i)=>{
          const y=141+i*68;
          return <g key={q.id} data-quota={q.id} data-used={q.used??"unknown"}>
            <QuotaLabel x={x} y={y} width={limitWidth-96} label={q.label.toUpperCase()}/>
            <text x={x+limitWidth} y={y} fontSize="20" fill={C.secondary} textAnchor="end">{q.used===null?"—":`${Number(q.used.toFixed(1))}%`}</text>
            <Segments x={x} y={y+9} width={limitWidth} value={q.used}/>
            <text x={x} y={y+37} fontSize="11" fill={C.data}>{q.used===null&&!q.resetsAt?"USAGE NOT REPORTED":q.reset}</text>
            <text x={x+limitWidth} y={y+37} fontSize="11" fill={C.interactive} textAnchor="end">{q.windowSeconds!==null?quotaPeriodLabel(q.windowSeconds,q.label):""}</text>
          </g>;
        })}
        {codex&&shown.map((q,i)=>{
          const y=141+i*128, rows=shown.length>1?3:5, cellH=shown.length>1?11:17;
          return <g key={q.id} data-quota={q.id} data-used={q.used??"unknown"}>
            <text x={x} y={y} fontSize="18" fill={C.text}>{quotaPeriodLabel(q.windowSeconds,q.label)}</text>
            <text x={x+limitWidth} y={y} fontSize="24" fill={C.secondary} textAnchor="end">{q.used===null?"—":`${Number(q.used.toFixed(1))}% USED`}</text>
            <g aria-hidden="true">{Array.from({length:rows*20},(_,j)=>{
              const used=q.used===null?0:Math.max(0,Math.min(1,q.used/100*rows*20-j));
              const px=x+(j%20)*19.3,py=y+17+Math.floor(j/20)*(cellH+4);
              return <g key={j}><rect x={px} y={py} width="15.3" height={cellH} fill={C.data} opacity=".19"/>{used>0&&<rect x={px} y={py} width={15.3*used} height={cellH} fill={C.data}/>}</g>;
            })}</g>
            <text x={x} y={y+rows*(cellH+4)+35} fontSize="14" fill={C.text}>{q.reset}</text>
          </g>;
        })}
        {codex&&!showEmpty&&shown.length===1&&<g>
          <path d={`M${x} 324H${x+limitWidth}`} stroke={C.interactive} strokeWidth="2"/>
          <text x={x} y="354" fontSize="19" fill={C.data}>{shown[0]!.remaining===null?"CAPACITY AWAITING UPDATE":`${Number(shown[0]!.remaining!.toFixed(1))}% REMAINING`}</text>
          <text x={x+limitWidth} y="383" fontSize="13" fill={C.interactive} textAnchor="end">{view.resetCredits===null?"PROVIDER-REPORTED LIMIT":`${view.resetCredits} RESET CREDITS AVAILABLE`}</text>
        </g>}
        <Heading x={right} y={96} width={rightWidth} label={`RECORDED TOKENS / ${view.period}`}/>
        <text x={right} y="154" fontSize="34" fill={C.secondary}>{view.total}</text>
        <text x={right+rightWidth} y="154" fontSize="11" fill={C.text} textAnchor="end">LOCAL LOGS</text>
        {view.channels.map((channel,i)=><g key={channel.label}>
          <rect x={right} y={173+i*24} width="5" height="14" fill={i%2?C.data:C.interactive}/>
          <text x={right+12} y={185+i*24} fontSize="14" fill={C.text}>{channel.label}</text>
          <text x={right+rightWidth} y={185+i*24} fontSize="16" fill={C.data} textAnchor="end">{channel.value}</text>
        </g>)}
        <Heading x={right} y={289} width={rightWidth} label="DAILY TOKENS / LAST 7 DAYS"/>
        <text x={right+rightWidth} y="320" fontSize="12" fill={C.interactive} textAnchor="end">{view.days.some(d=>d.value!==null)?`SCALE ${formatTokens(historyMax)}`:"NO HISTORY REPORTED"}</text>
        <path d={`M${right} 363H${right+rightWidth}`} stroke={C.interactive}/>
        {view.days.map((day,i)=>{
          const bx=right+i*rightWidth/7, bw=rightWidth/7-7, h=day.value===null?0:day.value/historyMax*32;
          return <g key={day.date} data-history-date={day.date} data-history-value={day.value??"unknown"}>
            {day.value===null?<text x={bx+bw/2} y="353" fontSize="15" fill={C.interactive} textAnchor="middle">—</text>:<rect x={bx} y={363-Math.max(1,h)} width={bw} height={Math.max(1,h)} fill={i===6?C.secondary:C.data}/>}
            <text x={bx+bw/2} y="382" fontSize="11" fill={C.text} textAnchor="middle">{day.label}</text>
            <title>{day.date}: {day.value===null?"not reported":`${day.value.toLocaleString("en-US")} tokens`}</title>
          </g>;
        })}
      </g>
    </svg>
    {pageCount>1&&<button type="button" className="lcars-quota-next" onClick={advance} onKeyDown={event=>{if(event.key==="Enter")event.stopPropagation();}} aria-label="Next quota windows"/>}
    <nav className="lcars-mode-bank" aria-label="LCARS mode">{LCARS_MODES.map(mode=><button key={mode} type="button" aria-current={mode===id?"page":undefined} onKeyDown={event=>{if(event.key==="Enter")event.stopPropagation();}} onClick={()=>onModeChange(mode)}>{LABELS[mode]}</button>)}</nav>
  </main>;
});
