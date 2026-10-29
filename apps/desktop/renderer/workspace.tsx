import { SshSettings } from "./ssh-settings.js";
import { AppUpdate } from "./app-update.js";
import { ExportScopePanel } from "./export-scope.js";
import { McpManager } from "./mcp-manager.js";
import { SyncStatus } from "./sync-status.js";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { WorkspaceBridge, WorkspaceBinding, WorkspaceForm } from "../bridge/workspace-contracts.js";
declare global { interface Window { workspaceSetup: WorkspaceBridge } }

import { DomainManager } from "./domains.js";

import { RecoveryPanel } from "./recovery.js";

import { MigrationPanel } from "./migration.js";

function App() {
  const [form, setForm] = useState<WorkspaceForm>({ creationId: crypto.randomUUID(), name: "我的工作空间", kind: "local", directory: "", url: "" });
  const [token, setToken] = useState("");
  const [binding, setBinding] = useState<WorkspaceBinding | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(true);
  const [uncertain, setUncertain] = useState(false);
  const [opened, setOpened] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [verified, setVerified] = useState<{ ticket: string; workspace: WorkspaceBinding["workspace"]; location: string } | null>(null);
  async function inspect() {
    setBusy(true); setMessage(""); setVerified(null);
    try {
      const result = await window.workspaceSetup.inspect({ kind: form.kind, directory: form.directory, url: form.url, token });
      if (result.status === "verified") setVerified(result);
      else if (result.status === "rejected") setMessage(result.message);
    } catch { setMessage("暂时无法核验空间，请检查连接后重试。"); }
    finally { setBusy(false); }
  }
  async function connect() {
    if (!verified) return;
    setBusy(true); setMessage("");
    try {
      const result = await window.workspaceSetup.connect(verified.ticket);
      if (result.status === "connected") {
        setBinding(result.binding); setToken(""); setConnecting(false);
        setMessage("已接入同一空间。本机已有内容可离线使用，正在接续统一位置进度。");
      } else if (result.status === "rejected") setMessage(result.message);
    } catch { setMessage("接入暂不能确认，已保留原绑定，请重新核验。"); }
    finally { setBusy(false); setVerified(null); }
  }
  useEffect(() => { void window.workspaceSetup.load().then((screen) => {
    setBinding(screen.binding);
    setForm(screen.pending ?? { ...form, directory: screen.defaultDirectory });
    setOpened(!!screen.pending);
    setUncertain(!!screen.pending && screen.pendingOutcome !== "rejected");
    if (screen.error) setMessage(screen.error);
  }).catch(() => setMessage("暂时无法读取本机创建信息，请重试。")).finally(() => setBusy(false)); }, []);
  function update(values: Partial<WorkspaceForm>) { setForm({ ...form, ...values, creationId: crypto.randomUUID() }); setMessage(""); }
  async function create() {
    setBusy(true); setMessage("");
    try {
      const result = await window.workspaceSetup.create({ ...form, token });
      if (result.status === "created" && result.binding) { setBinding(result.binding); setToken(""); setUncertain(false); }
      else { setMessage(result.status === "created" ? "空间已创建，本机绑定仍需核对。" : result.message); setUncertain(result.status !== "rejected"); }
    } catch { setMessage("尚不能确认创建结果，请保留当前信息后核对。"); setUncertain(true); }
    finally { setBusy(false); }
  }
  return <main>
    <div className="window-chrome"><span>我的工作空间</span><div><button aria-label="最小化窗口" onClick={() => void window.workspaceSetup.windowAction("minimize")}>−</button><button aria-label="关闭窗口" onClick={() => void window.workspaceSetup.windowAction("request-close") }>×</button></div></div>
    <header className="page-heading"><div><div className="eyebrow">个人信息统一工作空间</div><h1>让信息有一个归处。</h1><p>选择统一位置，保留同一份进度。</p></div></header>
    {binding ? <section className="card" data-testid="workspace-created">
      <h2>{binding.workspace.name}</h2><p>当前工作空间已建立，存放位置如下。</p>
      <dl><dt>工作空间身份</dt><dd data-testid="workspace-id">{binding.workspace.workspaceId}</dd>
        <dt>{binding.endpoint ? "统一位置" : "本机恢复位置（待核验统一位置）"}</dt><dd data-testid="workspace-location">{binding.location}</dd>
        <dt>服务地址</dt><dd>{binding.endpoint || "尚未接入，正在使用本机进度"}</dd></dl>
      <p>{!binding.endpoint ? "当前使用恢复的本机进度，可离线记录。核验当前生效位置后补同步。" : binding.kind === "local" ? "当前仅限这台电脑的回环地址访问，其他设备尚未接入。" : "空间位于你选择的自管服务器。其他设备仍需分别接入。"}</p>
      <p className="scope-note">领域数据按当前工作空间保存。MCP 接入权限可单独管理，导出前请核对来源范围。</p>
      {message && <p role="alert">{message}</p>}
    </section> : <>
      <div className="workspace-grid"><section className="card"><h2>创建新工作空间</h2><p>在本机或已准备好的服务器建立一个新空间。</p>
        <button className="primary" onClick={() => setOpened(true)} disabled={busy}>创建新工作空间</button></section>
        <section className="card"><h2>连接已有工作空间</h2><p>已有空间保持原身份和内容，不通过创建来覆盖。</p>
          <button disabled={busy || uncertain} onClick={() => { setConnecting(true); setOpened(false); setMessage(""); }}>连接已有工作空间</button></section></div>
      {opened && <section className="card workspace-form">
        <label htmlFor="space-name">工作空间名称</label><input id="space-name" value={form.name} disabled={busy || uncertain} onChange={(event) => update({ name: event.target.value })} />
        <label htmlFor="space-kind">统一位置</label><select id="space-kind" value={form.kind} disabled={busy || uncertain} onChange={(event) => update({ kind: event.target.value as "local" | "remote" })}>
          <option value="local">这台电脑</option><option value="remote">已准备好的自管服务器</option></select>
        {form.kind === "local" ? <><label htmlFor="space-directory">本机存放目录</label><input id="space-directory" value={form.directory} disabled={busy || uncertain} onChange={(event) => update({ directory: event.target.value })} />
          <button className="text-button" disabled={busy || uncertain} onClick={() => void window.workspaceSetup.chooseDirectory().then((directory) => { if (directory) update({ directory }); })}>选择目录</button>
          <p>无需外网即可创建。已有 workspace.sqlite 不会被覆盖。</p></>
          : <><label htmlFor="space-url">服务器地址</label><input id="space-url" value={form.url} placeholder="https://你的服务器地址/" disabled={busy || uncertain} onChange={(event) => update({ url: event.target.value })} />
            <label htmlFor="space-token">所有者接入凭据</label><input id="space-token" type="password" value={token} autoComplete="off" disabled={busy || uncertain} onChange={(event) => { setToken(event.target.value); update({}); }} />
            <p>服务器需事先启动并具备有效接入条件；此处不购买或部署云资源。</p></>}
        {message && <p role="alert">{message}</p>}
        <button className="primary" disabled={busy} onClick={() => void create()}>{busy ? "正在创建…" : uncertain ? "核对并继续原创建" : "确认创建"}</button>
      </section>}
      {!opened && !connecting && message && <p role="alert">{message}</p>}
    </>}
    {binding && <button className="binding-recheck" disabled={busy} onClick={() => { setConnecting(true); setMessage(""); }}>重新核验已有空间</button>}
    {connecting && <section className="card workspace-form" data-testid="workspace-connection">
      <h2>接入已有工作空间</h2>
      <label htmlFor="connect-kind">已有空间位置</label>
      <select id="connect-kind" value={form.kind} disabled={busy} onChange={(e) => { update({ kind: e.target.value as "local" | "remote" }); setVerified(null); }}>
        <option value="local">这台电脑</option><option value="remote">已准备好的自管服务器</option>
      </select>
      {form.kind === "local" ? <>
        <label htmlFor="connect-directory">已有空间目录</label>
        <input id="connect-directory" value={form.directory} disabled={busy} onChange={(e) => { update({ directory: e.target.value }); setVerified(null); }} />
        <button disabled={busy} onClick={() => void window.workspaceSetup.chooseDirectory().then((directory) => { if (directory) { update({ directory }); setVerified(null); } })}>选择已有目录</button>
      </> : <>
        <label htmlFor="connect-url">已有服务器地址</label>
        <input id="connect-url" value={form.url} disabled={busy} onChange={(e) => { update({ url: e.target.value }); setVerified(null); }} />
        <label htmlFor="connect-token">已有空间接入凭据</label>
        <input id="connect-token" type="password" autoComplete="off" value={token} disabled={busy} onChange={(e) => { setToken(e.target.value); setVerified(null); }} />
      </>}
      <button disabled={busy} onClick={() => void inspect()}>{busy ? "正在处理…" : "核验目标空间"}</button>
      {verified && <div data-testid="connection-preview"><h3>{verified.workspace.name}</h3>
        <p>工作空间身份：{verified.workspace.workspaceId}</p><p>权威身份：{verified.workspace.authorityId}</p><p>{verified.location}</p>
        <button disabled={busy} onClick={() => void connect()}>确认接入此空间</button>
      </div>}
      {!binding && message && <p role="alert">{message}</p>}
      <button disabled={busy} onClick={() => { setConnecting(false); setVerified(null); setToken(""); }}>取消接入</button>
    </section>}
    {binding && <><SyncStatus /><DomainManager key={binding.workspace.workspaceId} /><McpManager /><ExportScopePanel /></>}
    <SshSettings />
    <AppUpdate />
    <RecoveryPanel onBinding={setBinding} />
    <MigrationPanel onBinding={setBinding} />
    <footer className="page-footer">空间身份独立于名称 · 原数据不会被创建动作覆盖</footer>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);

