import { useEffect, useRef, useState } from "react";
import type { SyncScreen } from "../bridge/workspace-contracts.js";

export function SyncStatus() {
  const [state, setState] = useState<SyncScreen | null>(null);
  const active = useRef(false);
  const mounted = useRef(true);
  async function refresh(now = false) {
    if (active.current) return;
    active.current = true;
    try {
      const result = await window.workspaceSetup.sync(now ? "now" : "status");
      if (mounted.current) {
        setState(result);
        if (now || (result.lastSuccessAt && result.lastSuccessAt !== lastSuccess.current)) window.dispatchEvent(new Event("workspace:replica-updated"));
        lastSuccess.current = result.lastSuccessAt;
      }
    } catch { if (mounted.current) setState((previous) => ({ pending: 0, uncertain: 0, conflicts: 0, confirmed: 0, cursor: 0, lastSuccessAt: null, ...previous,
      phase: "unconfirmed", message: "暂时无法读取同步结果；本机内容和当前输入保留。" })); }
    finally { active.current = false; }
  }
  const lastSuccess = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true; void refresh();
    const resume = () => void refresh(true);
    const timer = window.setInterval(() => void refresh(), 1000);
    window.addEventListener("online", resume); window.addEventListener("focus", resume);
    return () => { mounted.current = false; window.clearInterval(timer); window.removeEventListener("online", resume); window.removeEventListener("focus", resume); };
  }, []);
  return <section className="sync-status" aria-label="同步状态" data-testid="workspace-sync-status">
    <p role="status">{state?.message ?? "正在读取同步状态…"}</p>
    {state && state.phase !== "synced" && state.cursor === 0 && state.pending === 0 && state.confirmed === 0 && <p>暂无可用的本机内容，尚不能判断统一位置是否为空。</p>}
    {state && <small>待同步 {state.pending} · 待处理冲突 {state.conflicts}{state.lastSuccessAt ? " · 最近接续 " + new Date(state.lastSuccessAt).toLocaleTimeString() : " · 尚未取得最新进度"}</small>}
    <button disabled={state?.phase === "syncing"} onClick={() => { setState((previous) => previous ? { ...previous, phase: "syncing", message: "同步中…" } : previous); void refresh(true); }}>立即同步</button>
  </section>;
}
