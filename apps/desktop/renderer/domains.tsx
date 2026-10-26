import { useEffect, useRef, useState } from "react";
import type { DomainEntry, ExtensionDefinition } from "@workspace/contracts";

import { TodoCapture } from "./todo-capture.js";
import { DomainView } from "./domain-view.js";
import type { DomainViewHandle } from "./domain-view.js";
export function DomainManager() {
  const [selected, setSelected] = useState<DomainEntry | null>(null);
  const view = useRef<DomainViewHandle>(null);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  function guard(action: () => void) {
    if (view.current?.dirty) setPendingAction(() => action);
    else action();
  }
  const [domains, setDomains] = useState<readonly DomainEntry[]>([]);
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<ExtensionDefinition | null>(null);
  const [operationId, setOperationId] = useState(crypto.randomUUID());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{ action: "enable" | "disable" | "remove-program"; domainId: string } | null>(null);
  async function request(action: "list" | "preview" | "register" | "enable" | "disable" | "remove-program", domainId?: string) {
    setBusy(true); setMessage("");
    try {
      const result = await window.workspaceSetup.domains({ action, source, operationId, ...(domainId ? { domainId } : {}) });
      if (!result.ok) { setMessage(result.message); return; }
      if (result.domains) { setDomains(result.domains); setConfirmation(null); if (action === "disable" || action === "remove-program") setSelected(null); }
      if (action === "enable" || action === "disable") setOperationId(crypto.randomUUID());
      if (result.preview) setPreview(result.preview);
      if (result.message) setMessage(result.message);
      if (action === "register") { setSource(""); setPreview(null); setOperationId(crypto.randomUUID()); }
    } catch { setMessage("领域操作暂不能确认，请保留输入后核对。"); }
    finally { setBusy(false); }
  }
  useEffect(() => { void window.workspaceSetup.domains({ action: "list" }).then((result) => {
    if (result.ok && result.domains) {
      setDomains(result.domains);
      setSelected(result.domains.find((domain) => domain.definition.domainId === "builtin.todo" && domain.enabled && domain.programAvailable) ?? null);
    } else if (!result.ok) setMessage(result.message);
  }).catch(() => setMessage("无法读取本机领域目录，原登记保留。")); }, []);
  useEffect(() => {
    const updated = () => void window.workspaceSetup.domains({ action: "list" }).then((result) => {
      if (!result.ok || !result.domains) return;
      setDomains(result.domains);
      setSelected((current) => current ? result.domains!.find((domain) => domain.definition.domainId === current.definition.domainId) ?? current : null);
    }).catch(() => setMessage("暂时无法刷新领域目录，当前输入保留。"));
    window.addEventListener("workspace:replica-updated", updated); return () => window.removeEventListener("workspace:replica-updated", updated);
  }, []);
  useEffect(() => {
    const floating = selected?.definition.domainId === "builtin.todo";
    document.body.classList.toggle("floating", floating);
    void window.workspaceSetup.windowAction(floating ? "floating" : "management");
    return () => { document.body.classList.remove("floating"); };
  }, [selected?.definition.domainId]);
  useEffect(() => window.workspaceSetup.onCloseRequested(() => guard(() => { void window.workspaceSetup.windowAction("close"); })));
  return <section className="card" data-testid="domain-manager" data-floating={selected?.definition.domainId === "builtin.todo" ? "true" : "false"}><h2>信息领域</h2>
    <p>当前显示本机登记；接续情况见同步状态。</p>
    {selected && (!selected.enabled || !selected.programAvailable) && <p role="alert">领域已停用或程序不可用，已有内容及当前输入保留；新的写入暂不可用。</p>}
    {selected && <><button onClick={() => guard(() => setSelected(null))}>返回领域目录</button>{selected.definition.domainId === "builtin.todo" ? <TodoCapture ref={view} onManagement={() => guard(() => setSelected(null))} /> : <DomainView key={selected.definition.domainId} domain={selected} ref={view} />}</>}
    {pendingAction && <div role="group" aria-label="处理未保存输入"><p>当前领域有未保存输入，请先处理。结果尚未确认或正在提交时，请先核对原操作，不能放弃。</p><button autoFocus onClick={() => void view.current?.save().then((saved) => { if (saved) { pendingAction(); setPendingAction(null); } })}>保存后继续</button><button onClick={() => void (async () => { if (!view.current || await view.current.discard()) { pendingAction(); setPendingAction(null); } })()}>放弃输入并继续</button><button onClick={() => setPendingAction(null)}>取消操作</button></div>}
    {!domains.length && <p>尚未添加信息领域。</p>}
    {domains.map((domain) => <article key={domain.definition.domainId} data-testid={"domain-" + domain.definition.domainId}>
      <h3>{domain.definition.name}</h3><button disabled={busy || !domain.enabled || !domain.programAvailable} onClick={() => guard(() => setSelected(domain))}>进入领域</button><p>{domain.definition.domainId} · {domain.definition.version}</p>
      <p>{domain.programAvailable ? "本机程序可用" : "缺少本机程序，请提供原扩展包补齐"} · {domain.enabled ? "已启用" : "未启用"}</p>
      <button disabled={busy || (!domain.enabled && !domain.programAvailable)} onClick={() => { setConfirmation({ action: domain.enabled ? "disable" : "enable", domainId: domain.definition.domainId }); setOperationId(crypto.randomUUID()); }}>{domain.enabled ? "停用" : "启用"}</button>
      {domain.definition.domainId !== "builtin.todo" && <button disabled={busy || !domain.programAvailable} onClick={() => setConfirmation({ action: "remove-program", domainId: domain.definition.domainId })}>移除本机程序</button>}
    </article>)}
    {confirmation && <div role="group" aria-label="确认领域启停"><p>{confirmation.action === "remove-program" ? "仅移除当前设备程序，保留登记、启用状态、已有内容与待同步材料；其他设备程序不变。" : "将改变此领域在工作空间中的启用状态；已有内容和待同步成果保留。尚未同步时其他设备可能仍保留旧状态。"}</p>
      <button disabled={busy} onClick={() => guard(() => { void request(confirmation.action, confirmation.domainId); })}>确认{confirmation.action === "enable" ? "启用" : confirmation.action === "disable" ? "停用" : "移除本机程序"}</button>
      <button disabled={busy} onClick={() => setConfirmation(null)}>取消</button></div>}
    <h3>添加领域扩展／补齐程序</h3>
    <label htmlFor="extension-file">选择扩展 JSON 文件</label><input id="extension-file" type="file" accept=".json,application/json" disabled={busy}
      onChange={(e) => { const file = e.target.files?.[0]; if (file) void file.text().then((text) => { setSource(text); setPreview(null); setOperationId(crypto.randomUUID()); }); }} />
    <label htmlFor="extension-source">扩展 JSON</label><textarea id="extension-source" rows={7} value={source} disabled={busy}
      onChange={(e) => { setSource(e.target.value); setPreview(null); setOperationId(crypto.randomUUID()); }} />
    <button disabled={busy || !source} onClick={() => void request("preview")}>校验并查看扩展</button>
    {preview && <div data-testid="extension-preview"><p>{preview.name} · {preview.domainId} · {preview.version}</p>
      <p>兼容宿主 API {preview.hostApi}；数据格式 {preview.dataVersion}；访问范围：仅所属领域。</p>
      <button disabled={busy} onClick={() => void request("register")}>确认注册或补齐程序</button></div>}
    {message && <p role="status">{message}</p>}
  </section>;
}
