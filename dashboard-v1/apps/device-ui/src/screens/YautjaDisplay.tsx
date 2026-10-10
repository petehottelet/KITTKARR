// Revision 3. Recover failed iframe loads after a USB tunnel interruption.
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import "./yautja-mode-v1.css";

type Destination = "gallery" | "overview" | "kitt" | "lcars";
export interface YautjaDisplayHandle { advance: (delta: 1 | -1) => void }
export const YautjaDisplay = forwardRef<YautjaDisplayHandle, { onNavigate: (page: Destination) => void; onTalk: () => void }>(function YautjaDisplay({ onNavigate, onTalk }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const lastHeartbeat = useRef(Date.now());
  useImperativeHandle(ref, () => ({ advance: (delta) => frame.current?.contentWindow?.postMessage({ type: "yautja-preset", delta }, "http://127.0.0.1:4180") }), []);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden && frame.current && Date.now() - lastHeartbeat.current > 12000) {
        lastHeartbeat.current = Date.now();
        frame.current.src = `http://127.0.0.1:4180/yautja?reconnect=${Date.now()}`;
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== "http://127.0.0.1:4180" || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "yautja-heartbeat") lastHeartbeat.current = Date.now();
      if (event.data?.type === "yautja-talk") onTalk();
      if (event.data?.type === "yautja-navigate" && ["gallery", "overview", "kitt", "lcars"].includes(event.data.page)) onNavigate(event.data.page);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onNavigate, onTalk]);
  return <iframe ref={frame} className="yautja-mode" title="Yautja live camera" src="http://127.0.0.1:4180/yautja" onLoad={() => frame.current?.focus()} />;
});
