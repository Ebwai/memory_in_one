import { useState } from "react";
import type { ExportScope, JsonObject } from "@workspace/contracts";

export function ExportScopePanel() {
  const [opened, setOpened] = useState(false), [source, setSource] = useState<"authority" | "local">("authority"), [scope, setScope] = useState<ExportScope | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [confirmed, setConfirmed] = useState(false);
  async function preview() {
    setBusy(true); setScope(null); setConfirmed(false); setError("");
    try { setScope(await window.workspaceSetup.exportScope(source)); }
    catch { setError(source === "authority" ? "无法完整读取统一位置范围，来源未切换。可以恢复连接后重试，或主动选择本机来源。" : "本机范围读取失败，未把不可读数据当成空领域。"); }
    finally { setBusy(false); }
  }
  return <section className="card" data-testid="export-scope"><h2>工作空间数据导出</h2><p>先确认来源和范围。确认后可将该来源的完整快照保存为本地文件。</p>
    <button disabled={busy} onClick={() => setOpened(!opened)}>{opened ? "收起导出范围" : "选择导出范围"}</button>
    {opened && <><label>导出来源<select aria-label="导出来源" value={source} disabled={busy} onChange={e => { setSource(e.target.value as "authority" | "local"); setScope(null); setConfirmed(false); setError(""); }}><option value="authority">统一位置导出</option><option value="local">本机可恢复数据导出（可离线）</option></select></label>
      <button disabled={busy} onClick={() => void preview()}>查看所选来源范围</button><button disabled={busy} onClick={() => { setScope(null); setConfirmed(false); setBusy(true); void window.workspaceSetup.sync("now").then(() => setError("已尝试同步，请重新查看范围；其他离线设备未知改动仍不保证包含。")).catch(() => setError("同步未确认，可按所选来源继续查看实际持有范围。")).finally(() => setBusy(false)); }}>先尝试立即同步</button>
      {error && <p role="alert">{error}</p>}{scope && <div data-testid="export-preview"><h3>{scope.workspace.name}</h3><p>工作空间身份：{scope.workspace.workspaceId}</p><p>权威身份：{scope.workspace.authorityId}</p><p>来源：{scope.source === "local" ? "本机可恢复数据" : "统一位置"} · {scope.location}</p><p>读取时间：{scope.observedAt}</p>
        <p>待同步：{scope.pending} · 结果待核对：{scope.uncertain} · 冲突：{scope.conflicts} · 已保存冲突整理材料：{scope.savedEditing} · 调用记录：{scope.calls}</p>
        <h4>该来源持有的全部领域</h4>{scope.domains.map(d => <p key={d.domainId}>{String((d.registration?.definition as JsonObject)?.name ?? "未识别领域")} · {d.domainId} · {d.registration?.enabled ? "已启用" : "停用或无登记"} · 内容 {d.records} · 删除接续 {d.deletions}</p>)}
        <h4>范围包含</h4><ul>{scope.includes.map(t => <li key={t}>{t}</li>)}</ul><h4>范围说明</h4><ul>{scope.limitations.map(t => <li key={t}>{t}</li>)}</ul>
        <button disabled={confirmed} onClick={() => setConfirmed(true)}>确认按此来源范围继续</button>{confirmed && <><p role="status">范围已确认。保存时生成新的完整快照，后续改动不混入本次文件。</p><button disabled={busy} onClick={() => { setBusy(true); setError(""); void window.workspaceSetup.exportFile(source).then(r => setError(r.cancelled ? "已取消导出，原数据保持不变。" : "导出完成：" + r.path + " · 快照时间：" + r.capturedAt)).catch(() => setError("导出未完成，原数据及原有有效文件保持不变，请检查位置、空间及来源连接后重试。")).finally(() => setBusy(false)); }}>生成快照并保存文件</button></>}
      </div>}</>}
  </section>;
}
