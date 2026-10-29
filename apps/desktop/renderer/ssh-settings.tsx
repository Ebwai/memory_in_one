import { useEffect, useState } from "react";
import type { TunnelConfig, TunnelScreen } from "../host/ssh-tunnel.js";
export function SshSettings() {
  const [screen, setScreen] = useState<TunnelScreen | null>(null);
  const [form, setForm] = useState<TunnelConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { let alive = true; const refresh = () => void window.workspaceSetup.tunnel("status").then(value => { if (alive) { setScreen(value); setForm(previous => previous ?? value.config); } }).catch(() => {}); refresh(); const timer = setInterval(refresh, 1000); return () => { alive = false; clearInterval(timer); }; }, []);
  async function action(action: "key" | "save" | "disconnect") {
    setBusy(true); setError("");
    try { const value = await window.workspaceSetup.tunnel(action, form ?? undefined); setScreen(value); if (action !== "key") setForm(value.config); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "连接配置失败，请重试。"); }
    finally { setBusy(false); }
  }
  if (!form) return null;
  return <section className="card ssh-settings" data-testid="ssh-settings"><h2>服务器连接</h2><p>只需配置一次，以后打开应用自动连接。</p>
    <label>服务器 IP 或主机名<input value={form.host} disabled={busy} onChange={e => setForm({ ...form, host: e.target.value })} /></label>
    <label>SSH 用户名<input value={form.user} disabled={busy} onChange={e => setForm({ ...form, user: e.target.value })} /></label>
    <label>SSH 端口<input type="number" value={form.port} disabled={busy} onChange={e => setForm({ ...form, port: Number(e.target.value) })} /></label>
    <label>服务器主机指纹<input value={form.fingerprint} disabled={busy} onChange={e => setForm({ ...form, fingerprint: e.target.value })} /></label>
    <p>请与服务器管理员提供的 SHA256 指纹核对。私钥只保留在当前电脑，不上传。</p>
    <button disabled={busy} onClick={() => void action("key")}>{screen?.hasKey ? "更换 SSH 私钥" : "选择 SSH 私钥"}</button>
    <label><input type="checkbox" checked={form.enabled} disabled={busy} onChange={e => setForm({ ...form, enabled: e.target.checked })} />打开应用自动连接并在断线后重连</label>
    <button disabled={busy} onClick={() => void action("save")}>保存并连接</button>{" "}<button disabled={busy} onClick={() => void action("disconnect")}>断开连接</button>
    <p role="status">{error || screen?.message}</p><p className="scope-note">空间接入地址填写 http://127.0.0.1:43128；所有者凭据仍在空间接入页填写。</p>
  </section>;
}
