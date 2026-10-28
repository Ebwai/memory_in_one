import { useEffect, useState } from "react";
import type { UpdateAction, UpdateScreen } from "../bridge/update-contracts.js";

export function AppUpdate() {
  const [screen, setScreen] = useState<UpdateScreen | null>(null);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let mounted = true;
    const refresh = () => void window.workspaceSetup.update("status").then(value => { if (mounted) setScreen(value); }).catch(() => { if (mounted) setMessage("暂时无法读取更新状态。"); });
    refresh(); const timer = setInterval(refresh, 700);
    return () => { mounted = false; clearInterval(timer); };
  }, []);
  async function action(action: UpdateAction) {
    setPending(true); setMessage("");
    try { setScreen(await window.workspaceSetup.update(action)); }
    catch { setMessage("更新暂时失败，当前程序和数据已保留，请重试。"); }
    finally { setPending(false); }
  }
  const busy = pending || screen?.phase === "checking" || screen?.phase === "downloading";
  return <section className="card app-update" data-testid="app-update" aria-label="应用更新">
    <h2>应用更新</h2>
    <p>当前版本：{screen?.currentVersion ?? "正在读取…"}{screen?.version && <> · 新版本：{screen.version}</>}</p>
    <p role="status">{message || screen?.message}</p>
    {screen?.phase === "downloading" && <progress max={100} value={screen.progress ?? 0} aria-label="更新下载进度" />}
    {screen?.notes && <details><summary>新版说明</summary><p style={{ whiteSpace: "pre-wrap" }}>{screen.notes}</p></details>}
    <button disabled={busy || screen?.phase === "ready"} onClick={() => void action("check")}>检查更新</button>{" "}
    {screen?.canInstall && (screen.phase === "available" || screen.phase === "error" && screen.version) && <button className="primary" disabled={busy} onClick={() => void action("download")}>一键更新</button>}
    {screen?.phase === "ready" && <button className="primary" disabled={busy} onClick={() => void action("install")}>安装并重启</button>}
    <p className="scope-note">更新来自 Ebwai/memory_in_one 的 GitHub Release。更新后保留原工作空间；服务器需单独更新。</p>
  </section>;
}
