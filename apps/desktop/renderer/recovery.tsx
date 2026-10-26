import { useState } from "react";
import type { RecoverySummary } from "@workspace/adapters";
import type { WorkspaceBinding } from "../bridge/workspace-contracts.js";

export function RecoveryPanel({ onBinding }: { onBinding: (binding: WorkspaceBinding) => void }) {
  const [summary, setSummary] = useState<RecoverySummary | null>(null);
  const [ticket, setTicket] = useState(""), [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  async function preview() {
    setBusy(true); setMessage(""); setDone(false); setSummary(null); setTicket("");
    try { const result = await window.workspaceSetup.recovery("preview"); if (result) { setSummary(result.summary); setTicket(result.ticket); } }
    catch (error) { setMessage(error instanceof Error ? error.message : "材料或目标校验失败。"); }
    finally { setBusy(false); }
  }
  async function restore() {
    setBusy(true); setMessage("");
    try { const result = await window.workspaceSetup.recovery("restore", ticket); if (result) { setSummary(result.summary); setDone(true); } }
    catch (error) { setMessage(error instanceof Error ? error.message : "恢复未确认，请核对原目标后重试。"); }
    finally { setBusy(false); }
  }
  return <section className="card" data-testid="workspace-recovery"><h2>恢复工作空间数据</h2><p>选择导出文件和空白目录。预览不会写入或改变当前绑定。</p>
    <button disabled={busy} onClick={() => void preview()}>选择材料与恢复目标</button>
    {summary && <div data-testid="recovery-preview"><h3>{summary.workspace.name}</h3><p>工作空间身份：{summary.workspace.workspaceId}</p><p>权威身份：{summary.workspace.authorityId}</p>
      <p>来源：{summary.source === "local" ? "本机可恢复进度（不代表其他设备最新全量）" : "统一位置（不含其他设备尚未上传改动）"}</p><p>原位置仅作说明：{summary.location}</p><p>快照时间：{summary.capturedAt}</p><p>恢复目标：{summary.target}</p>
      <p>待同步：{summary.pending} · 结果待核对：{summary.uncertain} · 冲突：{summary.conflicts}</p>
      {summary.domains.map(d => <p key={d.domainId}>{d.name} · {d.domainId} · {d.available ? "内置程序可用" : "待补齐兼容程序，原始数据完整保留，可再次导出"}</p>)}
      {!done ? <><button disabled={busy} onClick={() => void restore()}>确认恢复到此空白目标</button><button disabled={busy} onClick={() => { setSummary(null); setTicket(""); }}>取消恢复</button></>
        : <><p role="status">恢复成功，原身份和接续材料已核对。{summary.source === "authority" ? "目标尚待迁移启用，当前不接受统一位置写入。" : "本机进度可离线使用；未自动连接原地址，待同步与冲突仍需继续处理。"}</p>
          {summary.source === "local" && <button disabled={busy} onClick={() => { setBusy(true); void window.workspaceSetup.recovery("use-local", ticket).then(result => { if (result?.binding) { onBinding(result.binding); setMessage("已使用恢复的本机进度；验证当前生效位置后方可同步。"); } }).catch(error => setMessage(String(error.message))).finally(() => setBusy(false)); }}>使用恢复的本机进度</button>}</>}
    </div>}{message && <p role="alert">{message}</p>}
  </section>;
}
