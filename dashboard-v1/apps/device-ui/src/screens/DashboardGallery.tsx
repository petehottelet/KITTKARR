// KITT gallery revision 6. Yautja local-camera tile replaces Analytics.
import type { ReactNode } from "react";

export type DashboardPage = "usage-trend" | "kitt" | "yautja" | "lcars";

interface DashboardGalleryProps {
  focusedIndex: number;
  onOpen: (page: DashboardPage) => void;
}

/**
 * Tile icon rendered as an inline Google Material Symbols path (Apache
 * License 2.0 — see THIRD_PARTY_NOTICES.md). Inlined because the kiosk is
 * offline and the device font set has no coverage for pictographic
 * codepoints — glyph-font icons render as tofu boxes there.
 */
function MaterialIcon({ d, size = 34 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 -960 960 960" width={size} height={size} aria-hidden="true">
      <path d={d} fill="currentColor" />
    </svg>
  );
}

// Material Symbols (outlined, 24px): bar_chart. LCARS glyph is an original rail-and-elbow composition.
const ICON_BAR_CHART = "M640-160v-280h160v280H640Zm-240 0v-640h160v640H400Zm-240 0v-440h160v440H160Z";



const MODULES: { id: DashboardPage; eyebrow: string; title: string; detail: string; icon: ReactNode }[] = [
  { id: "usage-trend", eyebrow: "7 DAYS", title: "Usage", detail: "Daily AI volume", icon: <MaterialIcon d={ICON_BAR_CHART} /> },
  { id: "kitt", eyebrow: "VOICE", title: "KITT mode", detail: "Your work co-pilot", icon: <img src="/assets/kitt-voicebox-v1.svg" width={34} height={34} alt="" aria-hidden="true" /> },
  { id: "yautja", eyebrow: "", title: "Yautja", detail: "Live thermal-style camera", icon: <svg viewBox="0 0 40 40" width={34} height={34} aria-hidden="true"><path d="M20 3L38 35H2Z" fill="none" stroke="currentColor" strokeWidth="3"/><path d="M17 16h6v6h-6z M11 26h6v6h-6z M23 26h6v6h-6z" fill="currentColor"/></svg> },
  { id: "lcars", eyebrow: "", title: "LCARS", detail: "Animated starship consoles", icon: <svg viewBox="0 0 40 34" width={34} height={34} aria-hidden="true"><path d="M12 2H38V8H15Q9 8 9 14V18H2V12Q2 2 12 2Z" fill="#ff9966"/><path d="M2 21H9V25Q9 28 15 28H38V33H12Q2 33 2 25Z" fill="#cc99cc"/><path d="M13 12H27V18H13Z M30 12H38V18H30Z" fill="#99ccff"/><path d="M13 21H22V25H13Z M25 21H38V25H25Z" fill="#ffcc66"/></svg> },
];

export function DashboardGallery({ focusedIndex, onOpen }: DashboardGalleryProps) {
  return (
    <div className="screen">
      <div className="hdr">
        <div>
          <div className="hdr-kicker">DASHBOARDS</div>
          <div className="hdr-title">Choose a view</div>
        </div>
        <div className="hdr-spacer" />
        <div className="hdr-hint">Turn dial · press to open</div>
      </div>
      <div className="gallery-grid">
        {MODULES.map((module, index) => (
          <button
            type="button"
            key={module.id}
            className={index === focusedIndex ? `gallery-card gallery-${module.id} is-focused` : `gallery-card gallery-${module.id}`}
            onClick={() => onOpen(module.id)}
          >
            <span className="gallery-icon">{module.icon}</span>
            {module.eyebrow && <span className="gallery-eyebrow">{module.eyebrow}</span>}
            <span className="gallery-title">{module.title}</span>
            <span className="gallery-detail">{module.detail}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
