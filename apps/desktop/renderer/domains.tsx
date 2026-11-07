import { isProjectDomain, isPresetDomain } from "@workspace/contracts";
import { useEffect, useRef, useState } from "react";
import type { DomainEntry, ExtensionDefinition } from "@workspace/contracts";

import { TodoCapture } from "./todo-capture.js";
import { DomainView } from "./domain-view.js";
import type { DomainViewHandle } from "./domain-view.js";
export function DomainManager({ workspaceId, initialManagement = false }: { workspaceId: string; initialManagement?: boolean }) {
  const initialized = useRef(false);
  const returnRequested = useRef(false);
  const [addMode, setAddMode] = useState<"none" | "template" | "extension">("none");
  const [compact, setCompact] = useState(() => localStorage.getItem("workspace.compact." + workspaceId) === "true");
  const [projectName, setProjectName] = useState("");
  const [template, setTemplate] = useState("project");
  const [projectId, setProjectId] = useState(() => "preset.project." + crypto.randomUUID());
  const [projectOperation, setProjectOperation] = useState(() => crypto.randomUUID());
  const [projectDialog, setProjectDialog] = useState<{ action: "rename-project" | "delete-project"; domainId: string; name: string; operationId: string } | null>(null);
  async function projectRequest(action: "create-project" | "rename-project" | "delete-project", domainId: string, text: string, operationId: string) {
    setBusy(true);
    try {
      const result = await window.workspaceSetup.domains({ action, domainId, text, operationId });
      if (!result.ok) { setMessage(result.message); return; }
      if (result.domains) {
        setDomains(result.domains);
        setSelected(current => current ? result.domains!.find(d => d.definition.domainId === current.definition.domainId) ?? null : null);
      }
      setProjectDialog(null); setMessage(result.message ?? "");
      if (action === "create-project") { setProjectName(""); setProjectId("preset." + template + "." + crypto.randomUUID()); setProjectOperation(crypto.randomUUID()); }
    } catch { setMessage("项目操作结果尚待确认，请保留输入后重试原操作。"); }
    finally { setBusy(false); }
  }
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
      initialized.current = true;
      setSelected(initialManagement && !returnRequested.current ? null : result.domains.find((domain) => domain.definition.domainId === "builtin.todo" && domain.enabled && domain.programAvailable) ?? null);
    } else if (!result.ok) setMessage(result.message);
  }).catch(() => setMessage("无法读取本机领域目录，原登记保留。")); }, []);
  useEffect(() => {
    const updated = () => void window.workspaceSetup.domains({ action: "list" }).then((result) => {
      if (!result.ok || !result.domains) return;
      setDomains(result.domains);
      setSelected((current) => current ? result.domains!.find((domain) => domain.definition.domainId === current.definition.domainId) ?? null : null);
    }).catch(() => setMessage("暂时无法刷新领域目录，当前输入保留。"));
    window.addEventListener("workspace:replica-updated", updated); return () => window.removeEventListener("workspace:replica-updated", updated);
  }, []);
  useEffect(() => { if (initialized.current) window.dispatchEvent(new CustomEvent("workspace:view", { detail: !!selected })); }, [selected?.definition.domainId]);
  useEffect(() => { const back = () => guard(() => { returnRequested.current = true; void window.workspaceSetup.domains({ action: "list" }).then(result => { if (result.ok && result.domains) { setDomains(result.domains); setSelected(result.domains.find(d => d.definition.domainId === "builtin.todo" && d.enabled && d.programAvailable) ?? null); } }).catch(() => setMessage("暂时无法返回工作台，请重试。")); }); window.addEventListener("workspace:return", back); return () => window.removeEventListener("workspace:return", back); });
  useEffect(() => {
    const floating = !!selected && compact;
    document.body.classList.toggle("floating", floating);
    void window.workspaceSetup.windowAction(floating ? "floating" : "management");
    return () => { document.body.classList.remove("floating"); };
  }, [selected?.definition.domainId, compact]);
  useEffect(() => { const toggle = () => guard(() => { if (!compact) setSelected(domains.find(d => d.definition.domainId === "builtin.todo") ?? null); setCompact(!compact); }); const manage = () => guard(() => { setCompact(false); setSelected(null); }); window.addEventListener("workspace:toggle-mode", toggle); window.addEventListener("workspace:manage", manage); return () => { window.removeEventListener("workspace:toggle-mode", toggle); window.removeEventListener("workspace:manage", manage); }; });
  useEffect(() => { const typing = (event: KeyboardEvent) => { if (!compact || selected?.definition.domainId === "builtin.todo" || event.ctrlKey || event.metaKey || event.altKey || document.querySelector("[role=dialog], [aria-label='处理未保存输入']")) return; const target = event.target as HTMLElement; if (target?.closest("input,textarea,select,[contenteditable=true]")) return; if (event.key.length === 1 || event.key === "Process") document.querySelector<HTMLTextAreaElement>("[data-testid=domain-view] textarea:not(:disabled)")?.focus(); }; window.addEventListener("keydown", typing, true); return () => window.removeEventListener("keydown", typing, true); });
  useEffect(() => window.workspaceSetup.onCloseRequested(() => guard(() => { void window.workspaceSetup.windowAction("close"); })));
  return <section className="card" data-testid="domain-manager" data-floating={selected && compact ? "true" : "false"} data-selected={selected ? "true" : "false"}><h2>信息领域</h2><select className="floating-plugin-select" aria-label="当前插件" value={selected?.definition.domainId ?? ""} onChange={e => guard(() => setSelected(domains.find(d => d.definition.domainId === e.target.value) ?? null))}>{domains.filter(d => d.enabled && d.programAvailable).map(d => <option key={d.definition.domainId} value={d.definition.domainId}>{d.displayName ?? d.definition.name}</option>)}</select>
    <nav className="plugin-nav" aria-label="插件目录"><div className="plugin-brand"><span className="pixel-mark" aria-hidden="true" />我的工作空间</div><span className="nav-caption">PLUGINS / 插件</span>{domains.map(domain => <button key={domain.definition.domainId} aria-current={selected?.definition.domainId === domain.definition.domainId ? "page" : undefined} disabled={busy || !domain.enabled || !domain.programAvailable} onClick={() => guard(() => setSelected(domain))}><span aria-hidden="true">{domain.definition.domainId === "builtin.todo" ? "▧" : isProjectDomain(domain.definition.domainId) ? "▱" : "▤"}</span>{domain.displayName ?? domain.definition.name}</button>)}<button onClick={() => guard(() => setSelected(null))}><span aria-hidden="true">＋</span>新建插件</button><div className="nav-bottom">{(["server", "workspace", "mcp", "settings"] as const).map(id => <button key={id} onClick={() => guard(() => { setCompact(false); setSelected(null); window.dispatchEvent(new CustomEvent("workspace:manage", { detail: { page: id } })); })}>{({server:"服务器",workspace:"工作空间",mcp:"MCP",settings:"设置"})[id]}</button>)}</div></nav>
    <p>当前显示本机登记；接续情况见同步状态。</p>
    {selected && (!selected.enabled || !selected.programAvailable) && <p role="alert">领域已停用或程序不可用，已有内容及当前输入保留；新的写入暂不可用。</p>}
    {selected && <><button onClick={() => guard(() => setSelected(null))}>返回领域目录</button>{selected.definition.domainId === "builtin.todo" ? <TodoCapture ref={view} compact={compact} onToggleMode={() => setCompact(value => { localStorage.setItem("workspace.compact." + workspaceId, String(!value)); return !value; })} onManagement={() => guard(() => setSelected(null))} /> : <DomainView key={selected.definition.domainId} domain={selected} ref={view} />}</>}
    {pendingAction && <div role="group" aria-label="处理未保存输入"><p>当前领域有未保存输入，请先处理。结果尚未确认或正在提交时，请先核对原操作，不能放弃。</p><button autoFocus onClick={() => void view.current?.save().then((saved) => { if (saved) { pendingAction(); setPendingAction(null); } })}>保存后继续</button><button onClick={() => void (async () => { if (!view.current || await view.current.discard()) { pendingAction(); setPendingAction(null); } })()}>放弃输入并继续</button><button onClick={() => setPendingAction(null)}>取消操作</button></div>}
    {!selected && <>
    {!domains.length && <p>尚未添加信息领域。</p>}
    {domains.map((domain) => <article key={domain.definition.domainId} data-testid={"domain-" + domain.definition.domainId}>
      <h3>{domain.displayName ?? domain.definition.name}</h3><button disabled={busy || !domain.enabled || !domain.programAvailable} onClick={() => guard(() => setSelected(domain))}>进入领域</button><p>{domain.definition.domainId} · {domain.definition.version}</p>
      <p>{domain.programAvailable ? "本机程序可用" : "缺少本机程序，请提供原扩展包补齐"} · {domain.enabled ? "已启用" : "未启用"}</p>
      <button disabled={busy || (!domain.enabled && !domain.programAvailable)} onClick={() => { setConfirmation({ action: domain.enabled ? "disable" : "enable", domainId: domain.definition.domainId }); setOperationId(crypto.randomUUID()); }}>{domain.enabled ? "停用" : "启用"}</button>
      {domain.definition.domainId !== "builtin.todo" && !isPresetDomain(domain.definition.domainId) && <button disabled={busy || !domain.programAvailable} onClick={() => setConfirmation({ action: "remove-program", domainId: domain.definition.domainId })}>移除本机程序</button>}
      {isProjectDomain(domain.definition.domainId) && <>
        <button disabled={busy} onClick={() => guard(() => setProjectDialog({ action: "rename-project", domainId: domain.definition.domainId, name: domain.displayName ?? domain.definition.name, operationId: crypto.randomUUID() }))}>重命名项目</button>
        <button disabled={busy} onClick={() => guard(() => setProjectDialog({ action: "delete-project", domainId: domain.definition.domainId, name: domain.displayName ?? domain.definition.name, operationId: crypto.randomUUID() }))}>删除项目</button>
      </>}
    </article>)}
    <div className="plugin-add-actions"><h3>已注册插件</h3><details><summary>＋ 新增插件</summary><button onClick={() => setAddMode("template")}>按模板新建插件</button><button onClick={() => setAddMode("extension")}>添加领域扩展／补齐程序</button></details></div>
    <section hidden={addMode !== "template"} aria-label="按模板新建插件"><h3>按模板新建插件</h3>
      <label>插件模板<select aria-label="插件模板" value={template} onChange={e => { setTemplate(e.target.value); setProjectId("preset." + e.target.value + "." + crypto.randomUUID()); setProjectOperation(crypto.randomUUID()); }}><option value="project">项目</option><option value="checklist">清单</option></select></label>
      <label>项目名称<input aria-label="项目名称" maxLength={100} value={projectName} disabled={busy} onChange={e => setProjectName(e.target.value)} /></label>
      <button disabled={busy || !projectName.trim()} onClick={() => guard(() => { void projectRequest("create-project", projectId, projectName, projectOperation); })}>创建项目插件</button>
    </section>
    {projectDialog && <div role="group" aria-label={projectDialog.action === "delete-project" ? "确认删除项目" : "重命名项目"}>
      {projectDialog.action === "delete-project" ? <p>确认删除“{projectDialog.name}”及其中全部项目想法和待办？</p> :
        <label>新项目名称<input aria-label="新项目名称" value={projectDialog.name} maxLength={100} disabled={busy} onChange={e => setProjectDialog({ ...projectDialog, name: e.target.value, operationId: crypto.randomUUID() })} /></label>}
      <button disabled={busy || projectDialog.action === "rename-project" && !projectDialog.name.trim()} onClick={() => { void projectRequest(projectDialog.action, projectDialog.domainId, projectDialog.name, projectDialog.operationId); }}>{projectDialog.action === "delete-project" ? "确认删除整个项目" : "保存项目名称"}</button>
      <button disabled={busy} onClick={() => setProjectDialog(null)}>取消项目操作</button>
    </div>}
    {confirmation && <div role="group" aria-label="确认领域启停"><p>{confirmation.action === "remove-program" ? "仅移除当前设备程序，保留登记、启用状态、已有内容与待同步材料；其他设备程序不变。" : "将改变此领域在工作空间中的启用状态；已有内容和待同步成果保留。尚未同步时其他设备可能仍保留旧状态。"}</p>
      <button disabled={busy} onClick={() => guard(() => { void request(confirmation.action, confirmation.domainId); })}>确认{confirmation.action === "enable" ? "启用" : confirmation.action === "disable" ? "停用" : "移除本机程序"}</button>
      <button disabled={busy} onClick={() => setConfirmation(null)}>取消</button></div>}
    <div hidden={addMode !== "extension"}><h3>添加领域扩展／补齐程序</h3>
    <label htmlFor="extension-file">选择扩展 JSON 文件</label><input id="extension-file" type="file" accept=".json,application/json" disabled={busy}
      onChange={(e) => { const file = e.target.files?.[0]; if (file) void file.text().then((text) => { setSource(text); setPreview(null); setOperationId(crypto.randomUUID()); }); }} />
    <label htmlFor="extension-source">扩展 JSON</label><textarea id="extension-source" rows={7} value={source} disabled={busy}
      onChange={(e) => { setSource(e.target.value); setPreview(null); setOperationId(crypto.randomUUID()); }} />
    <button disabled={busy || !source} onClick={() => void request("preview")}>校验并查看扩展</button>
    {preview && <div data-testid="extension-preview"><p>{preview.name} · {preview.domainId} · {preview.version}</p>
      <p>兼容宿主 API {preview.hostApi}；数据格式 {preview.dataVersion}；访问范围：仅所属领域。</p>
      <button disabled={busy} onClick={() => void request("register")}>确认注册或补齐程序</button></div>}
    </div></>}{message && <p role="status">{message}</p>}
  </section>;
}
