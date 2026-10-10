// Revision 3. Exact duration units shared by both live provider instruments.
import type { ProviderSnapshot, QuotaWindow } from "@carthing/contracts";
import { deriveState, formatAge, formatResetCountdown } from "@carthing/contracts";
import { cardState, displayQuotaWindows, formatTokens, tokenPeriodLabel } from "../components/Meter";
import { addDays } from "../data/history";
import { dayKeyInTimeZone } from "@carthing/contracts";

export const LCARS_MODES = ["claude", "codex"] as const;
export type LcarsMode = typeof LCARS_MODES[number];
export const cycleLcarsMode = (mode: LcarsMode, delta: 1 | -1): LcarsMode =>
  LCARS_MODES[(LCARS_MODES.indexOf(mode) + delta + LCARS_MODES.length) % LCARS_MODES.length]!;

export function quotaPeriodLabel(seconds: number | null, fallback: string) {
  if(seconds===null)return fallback.toUpperCase();
  if(seconds>=86400&&seconds%86400===0)return `${seconds/86400} DAY PERIOD`;
  if(seconds>=3600&&seconds%3600===0)return `${seconds/3600} HOUR PERIOD`;
  if(seconds>=60&&seconds%60===0)return `${seconds/60} MINUTE PERIOD`;
  return `${seconds} SECOND PERIOD`;
}

export function quotaReading(window: QuotaWindow, now: number) {
  const expired = window.resetsAt !== null && Date.parse(window.resetsAt) <= now;
  const used = expired || window.usedPercent === null || !Number.isFinite(window.usedPercent)
    ? null : Math.max(0, Math.min(100, window.usedPercent));
  const reset = expired ? "RESET PASSED / AWAITING UPDATE" :
    (formatResetCountdown(window.resetsAt, now)?.toUpperCase() ?? "NO RESET TIME REPORTED");
  return { ...window, used, remaining: used === null ? null : 100-used, reset };
}

export function usageView(provider: ProviderSnapshot | undefined, id: "claude" | "codex", now: number, timeZone: string, linkDown: boolean) {
  const state = provider ? cardState(provider, deriveState(provider, now), linkDown) : "unavailable";
  const source = provider?.source === "rollout-limits" ? "LOCAL LIMITS" : provider?.source === "oauth" ? "ACCOUNT LIMITS" : "COLLECTOR";
  const windows = provider ? displayQuotaWindows(id, provider.quotaWindows) : [];
  const quotas = windows.map(window => quotaReading(window, now));
  const today = dayKeyInTimeZone(now,timeZone);
  const history = provider?.history ?? [];
  const byDate = new Map(history.map(day => [day.date,day.total]));
  // Absent days remain gaps. Do not invent zeros outside supplied observations.
  const days = Array.from({length:7},(_,i)=>{
    const date=addDays(today,i-6);
    return {date,label:`${Number(date.slice(5,7))}/${Number(date.slice(8,10))}`,value:byDate.get(date) ?? null};
  });
  const tokens=provider?.tokens;
  return {
    state, source, age:formatAge(provider?.observedAt ?? null,now).toUpperCase(), quotas, days,
    period:tokens ? tokenPeriodLabel(tokens,now,timeZone).toUpperCase() : "NOT REPORTED",
    total:formatTokens(tokens?.total ?? null),
    channels:[
      {label:"INPUT",value:formatTokens(tokens?.input ?? null)},
      {label:"CACHED INPUT",value:formatTokens(tokens?.cachedInput ?? null)},
      {label:"OUTPUT",value:formatTokens(tokens?.output ?? null)},
      {label:"REASONING",value:formatTokens(tokens?.reasoning ?? null)},
    ],
    resetCredits:provider?.usageFacts?.resetCreditsAvailable ?? null,
  };
}
