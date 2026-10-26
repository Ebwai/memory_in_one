import { useState } from "react";
import type { WorkspaceBinding } from "../bridge/workspace-contracts.js";

export function MigrationPanel({ onBinding }: { onBinding: (binding: WorkspaceBinding) => void }) {
  const [kind, setKind] = useState<"local" | "remote">("local");
  const [directory, setDirectory] = useState(""), [url, setUrl] = useState(""), [token, setToken] = useState("");
  const [isolated, setIsolated] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  async function run(action: "status" | "stop" | "switch") {
    setBusy(true); setMessage("");
    try { const result = await window.workspaceSetup.migration(action, { kind, directory, url, token, isolated }); if (result.binding) { onBinding(result.binding); setToken(""); } setMessage(result.message); }
    catch (error) { setMessage(error instanceof Error ? error.message : "迁移结果待核对，原绑定与已保存内容已保留。"); }
    finally { setBusy(false); }
  }
  return <section className="card" data-testid="workspace-migration"><h2>迁移统一位置</h2><p>先停止旧位置写入，再导出、恢复到空白目标，最后明确切换。设备可继续离线记录，其他设备需分别改接。</p>
    <button disabled={busy} onClick={() => void run("status")}>核对旧位置状态</button><button disabled={busy} onClick={() => void run("stop")}>停止旧位置写入以开始迁移</button>
    <label>已恢复的目标类型<select aria-label="迁移目标类型" disabled={busy} value={kind} onChange={e => setKind(e.target.value as "local" | "remote")}><option value="local">这台电脑的恢复目录</option><option value="remote">已恢复的自管服务器</option></select></label>
    {kind === "local" ? <><label>已恢复的目标目录<input aria-label="迁移目标目录" disabled={busy} value={directory} onChange={e => setDirectory(e.target.value)} /></label><button disabled={busy} onClick={() => void window.workspaceSetup.chooseDirectory().then(path => { if (path) setDirectory(path); })}>选择已恢复目标</button></>
      : <><label>新服务器地址<input aria-label="迁移服务器地址" disabled={busy} value={url} onChange={e => setUrl(e.target.value)} /></label><label>新位置所有者凭据<input aria-label="迁移接入凭据" disabled={busy} type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} /></label></>}
    <label><input type="checkbox" disabled={busy} checked={isolated} onChange={e => setIsolated(e.target.checked)} />旧位置不可达时，我已将其停用或隔离；我接受所选材料覆盖边界，不包含其他设备未知改动</label>
    <button disabled={busy || kind === "local" && !directory || kind === "remote" && (!url || !token)} onClick={() => void run("switch")}>确认切换到已恢复的新位置</button>
    {message && <p role="status">{message}</p>}
  </section>;
}
