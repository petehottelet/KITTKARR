// KITT integration revision 10. LCARS wheel selects Claude and Codex usage.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderDisplayMetric, ProviderState } from "@carthing/contracts";
import { deriveState, formatAge, formatClock } from "@carthing/contracts";
import { useNow } from "./data/useNow";
import { useSnapshotSource } from "./data/useSnapshotSource";
import { useHardwareInput } from "./input/useHardwareInput";
import { cardState } from "./components/Meter";
import { formatReconnectDetail, StatusRail } from "./components/StatusRail";
import { Overview } from "./screens/Overview";
import { detailPageCount, ProviderDetail } from "./screens/ProviderDetail";
import { SystemStatus } from "./screens/SystemStatus";
import { FirstConnect } from "./screens/Messages";
import { DashboardGallery, type DashboardPage } from "./screens/DashboardGallery";
import { WeeklyUsageDashboard } from "./screens/ChartDashboards";
import { LcarsDisplay, type LcarsDisplayHandle } from "./screens/LcarsDisplay";

import { YautjaDisplay, type YautjaDisplayHandle } from "./screens/YautjaDisplay";

type Page = "overview" | "provider" | "gallery" | DashboardPage | "system";

const DASHBOARD_ORDER: DashboardPage[] = ["usage-trend", "kitt", "yautja", "lcars"];

const STATE_RANK: Record<ProviderState, number> = {
  live: 0,
  stale: 1,
  unavailable: 2,
  offline: 3,
  error: 4,
};

export default function App() {
  const source = useSnapshotSource();
  const now = useNow(source.skewMs);
  const [page, setPage] = useState<Page>("overview");
  const [activeProviderId, setActiveProviderId] = useState("claude");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [windowPage, setWindowPage] = useState(0);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const lcarsRef = useRef<LcarsDisplayHandle>(null);
  const yautjaRef = useRef<YautjaDisplayHandle>(null);
  const kittRef = useRef<HTMLIFrameElement>(null);
  const [kittReady, setKittReady] = useState(false);
  const kittTalkPending = useRef(false);
  const kittLastAlive = useRef(Date.now());
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);

  useEffect(() => setStage(stageRef.current), []);

  const providers = useMemo(() => {
    const byId = new Map((source.snapshot?.providers ?? []).map((provider) => [provider.id, provider]));
    return source.dashboardConfig.providers
      .filter((configured) => configured.enabled)
      .map((configured) => byId.get(configured.id))
      .filter((provider): provider is NonNullable<typeof provider> => provider !== undefined);
  }, [source.snapshot, source.dashboardConfig.providers]);
  const metricsForProvider = (id: string): ProviderDisplayMetric[] =>
    source.dashboardConfig.providers.find((provider) => provider.id === id)?.show ?? [
      "quota",
      "identity",
      "status",
      "metrics",
      "metricHistory",
      "resetCredits",
      "currentTokens",
      "lifetimeTokens",
      "peakDailyTokens",
      "streak",
      "history",
      "cost",
    ];

  useEffect(() => setWindowPage(0), [page]);
  useEffect(() => {
    if (providers.length === 0) return;
    setFocusedIndex((index) => Math.min(index, providers.length - 1));
  }, [providers.length]);

  const rotate = (delta: 1 | -1) => {
    if (page === "overview") {
      if (providers.length > 0) {
        setFocusedIndex((i) => (i + delta + providers.length) % providers.length);
      }
      return;
    }
    if (page === "gallery") {
      setGalleryIndex((index) => (index + delta + DASHBOARD_ORDER.length) % DASHBOARD_ORDER.length);
      return;
    }
    if (page === "lcars") {
      lcarsRef.current?.rotate(delta);
      return;
    }
    if (page === "kitt") {
      kittRef.current?.contentWindow?.postMessage({ type: "kitt-volume", delta }, "http://127.0.0.1:4180");
      return;
    }
    if (page === "yautja") {
      yautjaRef.current?.advance(delta);
      return;
    }
    if (page === "usage-trend") {
      return;
    }
    if (page === "provider") {
      const provider = providers.find((candidate) => candidate.id === activeProviderId);
      // Meter pages first, then daily/weekly/monthly/yearly history views.
      const pageCount = provider ? detailPageCount(provider, metricsForProvider(provider.id)) : 1;
      if (pageCount > 1) {
        setWindowPage((current) => (current + delta + pageCount) % pageCount);
      }
      return;
    }
  };

  const talkToKitt = () => {
    if (page === "kitt" && kittReady) {
      kittRef.current?.contentWindow?.postMessage({ type: "kitt-talk" }, "http://127.0.0.1:4180");
    } else {
      // The visibility effect sends kitt-visible before consuming this request.
      kittTalkPending.current = true;
      setPage("kitt");
    }
  };

  const press = () => {
    if (page === "overview") {
      const target = providers[focusedIndex];
      if (target) {
        setActiveProviderId(target.id);
        setPage("provider");
      }
      return;
    }
    if (page === "gallery") {
      setPage(DASHBOARD_ORDER[galleryIndex] ?? "usage-trend");
      return;
    }
    if (page === "kitt") {
      talkToKitt();
      return;
    }
    if (page === "lcars") {
      lcarsRef.current?.activate();
      return;
    }
    if (page === "usage-trend" || page === "yautja") {
      setPage("gallery");
      return;
    }
    setPage("overview");
  };

  useHardwareInput(stage, {
    onRotate: rotate,
    onPress: press,
    onBack: talkToKitt,
    // Preset layout: 1 dashboards gallery · 2 provider overview ·
    // 3 KITT voicebox · 4 LCARS (long-press 4 keeps System).
    onPreset: (n) => {
      if (n === 1) setPage("gallery");
      else if (n === 2) setPage("overview");
      else {
        setPage("kitt");
      }
    },
    onPreset4Short: () => setPage("lcars"),
    onPreset4Long: () => setPage("system"),
  });

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== "http://127.0.0.1:4180" || event.source !== kittRef.current?.contentWindow) return;
      if (event.data?.type === "kitt-alive" || event.data?.type === "kitt-ready") kittLastAlive.current = Date.now();
      if (event.data?.type === "kitt-ready") {
        setKittReady(true);
        // A reloaded iframe needs a new visibility message even when readiness
        // was already true; React will not rerun the readiness effect then.
        kittRef.current?.contentWindow?.postMessage({ type: "kitt-visible", visible: page === "kitt" }, "http://127.0.0.1:4180");
      }
      if (event.data?.type === "kitt-reminder") setPage("kitt");
      if (event.data?.type === "kitt-navigate") {
        if (event.data.page === "gallery" || event.data.page === "overview" || event.data.page === "system" || event.data.page === "lcars") setPage(event.data.page);
        if (event.data.page === "codex") { setActiveProviderId("codex"); setPage("provider"); }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [page]);
  useEffect(() => {
    kittRef.current?.contentWindow?.postMessage({ type: "kitt-visible", visible: page === "kitt" }, "http://127.0.0.1:4180");
    if (page !== "kitt") kittTalkPending.current = false;
    if (page === "kitt" && kittReady) {
      kittRef.current?.focus();
      if (kittTalkPending.current) {
        kittTalkPending.current = false;
        kittRef.current?.contentWindow?.postMessage({ type: "kitt-talk" }, "http://127.0.0.1:4180");
      }
    }
  }, [page, kittReady]);
  useEffect(() => {
    const refresh = window.setInterval(() => {
      kittRef.current?.contentWindow?.postMessage({ type: "kitt-visible", visible: page === "kitt" }, "http://127.0.0.1:4180");
    }, 2000);
    return () => window.clearInterval(refresh);
  }, [page]);
  useEffect(() => {
    const retry = window.setInterval(() => {
      if (Date.now() - kittLastAlive.current < 8000 || !kittRef.current) return;
      kittLastAlive.current = Date.now();
      setKittReady(false);
      kittRef.current.src = "http://127.0.0.1:4180/?embedded=1&retry=" + Date.now();
    }, 2000);
    return () => window.clearInterval(retry);
  }, []);

  // Dev nicety: in mock mode, M cycles through fixtures for review.
  useEffect(() => {
    if (!source.mockName) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "m" || ev.key === "M") source.cycleMock();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [source.mockName, source.cycleMock]);

  const rail = useMemo(() => {
    const right = source.mockName
      ? `MOCK · ${source.mockName}`
      : formatClock(now, source.timeZone);

    if (!source.snapshot) {
      const reconnecting = source.pairing === "paired" && source.link === "connecting";
      return {
        state: reconnecting ? ("reconnecting" as const) : ("disconnected" as const),
        detail:
          reconnecting
            ? "Looking for collector"
            : source.pairing === "missing"
            ? "Pairing required"
            : source.pairing === "rejected"
              ? "Pairing token rejected"
              : "No collector reachable",
        right,
      };
    }

    if (source.link !== "connected" && source.receivedAt) {
      return {
        state: "reconnecting" as const,
        detail: formatReconnectDetail(providers, source.timeZone),
        right,
      };
    }

    const states = providers.map((p) => cardState(p, deriveState(p, now)));
    const worst =
      states.length > 0
        ? states.reduce((a, b) => (STATE_RANK[b] > STATE_RANK[a] ? b : a))
        : ("unavailable" as ProviderState);
    const mixed = states.some((s) => s !== worst);

    // When providers disagree, attribute the state per provider so the
    // aggregate word never sits next to the wrong name.
    const detail = providers
      .map((p, i) => {
        const age = formatAge(p.observedAt, now);
        const s = states[i] ?? "unavailable";
        return mixed ? `${p.displayName} ${s} · ${age}` : `${p.displayName} ${age}`;
      })
      .join("   ·   ");

    return {
      state: worst,
      detail: worst === "live" ? `✳ ${detail}` : detail,
      right,
    };
  }, [source, providers, now]);

  const showFirstConnect =
    !source.snapshot ||
    (providers.length > 0 && providers.every((p) => p.state === "unavailable" && !p.observedAt));

  let content;
  if (page === "system") {
    content = (
      <SystemStatus
        snapshot={source.snapshot}
        link={source.link}
        activeEndpoint={source.activeEndpoint}
        endpoints={source.endpoints}
        mockName={source.mockName}
        now={now}
        receivedAt={source.receivedAt}
        skewMs={source.skewMs}
        pairing={source.pairing}
        timeZone={source.timeZone}
        youtubeChannel={source.youtubeChannel}
        ga4Property={source.ga4Property}
      />
    );
  } else if (page === "gallery") {
    content = <DashboardGallery focusedIndex={galleryIndex} onOpen={setPage} />;
  } else if (page === "usage-trend") {
    content = <WeeklyUsageDashboard />;
  } else if (page === "kitt") {
    content = null;
  } else if (page === "yautja") {
    content = <YautjaDisplay ref={yautjaRef} onNavigate={setPage} onTalk={talkToKitt} />;
  } else if (page === "lcars") {
    content = <LcarsDisplay ref={lcarsRef} providers={providers} now={now} timeZone={source.timeZone} linkDown={source.link !== "connected"} demo={!!source.mockName} />;
  } else if (showFirstConnect) {
    content = <FirstConnect endpoints={source.endpoints} pairing={source.pairing} />;
  } else if (page === "provider") {
    const provider = providers.find((p) => p.id === activeProviderId);
    content = provider ? (
      <ProviderDetail
        provider={provider}
        now={now}
        linkDown={source.link !== "connected"}
        windowPage={windowPage}
        timeZone={source.timeZone}
        metrics={metricsForProvider(provider.id)}
      />
    ) : (
      <FirstConnect endpoints={source.endpoints} pairing={source.pairing} />
    );
  } else {
    content = (
      <Overview
        providers={providers}
        now={now}
        focusedIndex={focusedIndex}
        linkDown={source.link !== "connected"}
        timeZone={source.timeZone}
        providerConfigs={source.dashboardConfig.providers}
        onOpen={(id) => {
          setActiveProviderId(id);
          setPage("provider");
        }}
      />
    );
  }

  return (
    <div className="stage" ref={stageRef}>
      {content}
      <div className="kitt-mode" style={{ display: page === "kitt" ? "block" : "none" }}>
        <iframe ref={kittRef} src="http://127.0.0.1:4180/?embedded=1" title="KITT voice assistant" className="kitt-frame" />
        {!kittReady && <div className="kitt-offline"><strong>K.I.T.T. is waiting for your Mac.</strong><p>Connect USB and start the K.I.T.T. host app.</p><button onClick={() => setPage("overview")}>Back to usage</button></div>}
      </div>
      {page !== "kitt" && page !== "lcars" && page !== "yautja" && <StatusRail
        state={rail.state}
        detail={rail.detail}
        right={rail.right}
        transport={source.snapshot?.transport}
        link={source.link}
      />}
    </div>
  );
}
