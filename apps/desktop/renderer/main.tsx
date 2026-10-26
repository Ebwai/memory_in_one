import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SaveStatus, applyLocalResult, createSaveStatus, restoreLocalStatus, startLocalSave } from "@workspace/ui";
import type { SavePhase, SaveStatusState } from "@workspace/ui";
import type { LocalSaveResult } from "@workspace/contracts";
import type { DemoSaveInput, StatusDemoBridge } from "../bridge/contracts.js";

declare global { interface Window { statusDemo: StatusDemoBridge } }
const scope = { workspaceId: "status-demo", domainId: "demo-notes", recordId: "current-note" };
const freshState = () => createSaveStatus({ ...scope, operationId: crypto.randomUUID() });
const previewPhases: SavePhase[] = ["saving", "pending", "syncing", "synced", "local-failed", "sync-failed", "local-unconfirmed", "conflict"];

function App() {
  const [state, setState] = useState<SaveStatusState>(freshState);
  const current = useRef(state);
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState("");
  const submitted = useRef<DemoSaveInput | null>(null);
  const loadingId = useRef(0);

  function present(next: SaveStatusState) { current.current = next; setState(next); }

  async function refresh(initial = false) {
    const requestId = ++loadingId.current;
    try {
      const loaded = await window.statusDemo.load();
      if (requestId !== loadingId.current) return;
      if (!loaded.ok) { setReadError(loaded.message); return; }
      setReadError("");
      setSavedText(typeof loaded.record?.payload?.text === "string" ? loaded.record.payload.text : "");
      if (initial && loaded.receipt) present(restoreLocalStatus(loaded.receipt));
    } catch { if (requestId === loadingId.current) setReadError("暂时无法读取本机内容，请稍后重试。"); }
    finally { if (initial) setLoading(false); }
  }

  useEffect(() => { void refresh(true); }, []);

  function edit(value: string) {
    setText(value);
    if (current.current.phase !== "unsaved") { present(freshState()); submitted.current = null; }
  }

  async function runSave(retry = false) {
    if (busy) return;
    const reference = current.current;
    const input = retry ? submitted.current : { operationId: reference.operationId, text };
    if (!input) return;
    submitted.current = input;
    present(startLocalSave(reference));
    setBusy(true);
    let result: LocalSaveResult;
    try { result = await window.statusDemo.save(input); }
    catch { result = { status: "save-unconfirmed", operationId: input.operationId, message: "尚不能确认保存结果。" }; }
    const before = current.current;
    const next = applyLocalResult(before, { ...scope, operationId: input.operationId }, result);
    present(next);
    if (next !== before && next.phase === "pending") setText("");
    setBusy(false);
    await refresh();
  }

  async function checkResult() {
    if (busy) return;
    const reference = current.current;
    setBusy(true);
    try {
      const result = await window.statusDemo.recover(reference.operationId);
      const before = current.current;
      const next = applyLocalResult(before, reference, result);
      present(next);
      if (next !== before && next.phase === "pending") setText("");
    } catch { /* Keep the existing unconfirmed result and input. */ }
    finally { setBusy(false); }
    await refresh();
  }

  return <main>
    <header className="page-heading"><div><div className="eyebrow">个人信息统一工作空间</div><h1>先留下，再继续。</h1>
      <p>记录有回音，进度有依据。</p></div><span className="demo-badge">保存状态演示</span></header>
    <div className="workspace-grid">
      <section className="editor card"><div className="section-heading"><h2>留下一个想法</h2><span>本机示例</span></div>
        <label htmlFor="draft">当前内容</label>
        <textarea id="draft" value={text} onChange={(event) => edit(event.target.value)} placeholder="此刻想到什么，先记在这里…"
          disabled={loading || current.current.phase === "local-unconfirmed"} maxLength={32000} />
        <div className="editor-footer"><span>保存后会保留在本机</span><button className="primary" type="button"
          disabled={loading || busy || !!readError || !text.trim() || state.phase === "local-unconfirmed"} onClick={() => void runSave()}>保存到本机</button></div>
        <div data-testid="current-status"><SaveStatus state={state} onRetryLocal={() => void runSave(true)} onCheckResult={() => void checkResult()} /></div>
        <p className="scope-note">当前演示未接入服务器，真实记录会显示为“待同步”。</p>
      </section>
      <aside className="saved card"><div className="section-heading"><h2>本机已保存</h2><button className="text-button" onClick={() => void refresh()} disabled={loading}>重新读取</button></div>
        <p className="saved-label">关闭窗口后，重新打开仍可读取</p>
        {readError && <p className="read-error" role="alert">{readError}</p>}
        <div data-testid="saved-content" className={"saved-content" + (savedText ? "" : " empty")}>{loading ? "正在读取…" : savedText || (readError ? "本机内容暂时无法读取" : "还没有已保存内容")}</div>
      </aside>
    </div>
    <section className="preview"><div className="section-heading"><div><h2>状态含义预览</h2>
      <p>以下为展示样例。网络同步和冲突处理尚未接入。</p></div></div>
      <div className="status-grid">{previewPhases.map((phase) => <SaveStatus key={phase}
        state={{ ...createSaveStatus({ ...scope, operationId: "preview-" + phase }), phase,
          localSequence: phase.startsWith("local") || phase === "saving" ? null : 1,
          failureReason: phase === "local-failed" ? "storage-unavailable" : null }} />)}</div>
    </section>
    <footer className="page-footer">每次改动独立确认 · 本机保存与同步状态分别呈现</footer>
  </main>;
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App />);

