import { useState } from "react";
import type { AuthorityVersion, McpCall, McpGrant, JsonObject } from "@workspace/contracts";

const actions: [string, string][] = [["read", "内容查询"], ["create", "新增内容"], ["update", "修改内容"], ["date", "设置日期"], ["complete", "完成待办"], ["restore", "恢复未完成"], ["delete", "删除（逐次确认）"], ["directory", "领域目录"], ["register", "注册领域"], ["enable", "启用领域"], ["disable", "停用领域"], ["install", "补齐服务器程序"], ["remove", "移除服务器程序"], ["backup", "完整备份（所有领域）"], ["recovery", "备份恢复（所有领域）"], ["migration", "迁移控制（所有领域）"]];
export function McpManager() {
  const [opened, setOpened] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [grants, setGrants] = useState<McpGrant[]>([]), [calls, setCalls] = useState<McpCall[]>([]), [domains, setDomains] = useState<AuthorityVersion[]>([]);
  const [name, setName] = useState(""), [selected, setSelected] = useState<string[]>([]), [allowed, setAllowed] = useState(["read"]), [allDomains, setAllDomains] = useState(false), [fullAccess, setFullAccess] = useState(false);
  const [credentials, setCredentials] = useState<Record<string, string>>({}), [visible, setVisible] = useState<string[]>([]), [copyStatus, setCopyStatus] = useState("");
  const [configuration, setConfiguration] = useState<unknown>(null);
  async function load() {
    setBusy(true); setError("");
    try {
      setGrants(await window.workspaceSetup.mcp("grants") as McpGrant[]);
      setCalls(await window.workspaceSetup.mcp("calls") as McpCall[]);
      try { setCredentials(await window.workspaceSetup.mcp("credentials") as Record<string, string>); } catch { setCredentials({}); setError("无法读取本机保存的凭据。已有授权仍可使用，首次凭据请及时复制。"); }
      setDomains(await window.workspaceSetup.mcp("directory") as AuthorityVersion[]);
    } catch { setError("统一位置暂不可达，无法核对授权与调用记录。请恢复连接后刷新。"); }
    finally { setBusy(false); }
  }
  async function create() {
    setBusy(true); setError("");
    try {
      const result = await window.workspaceSetup.mcp("grant-create", { name, domains: allDomains || fullAccess ? ["*"] : selected, actions: fullAccess ? [...actions.map(([id]) => id), "delete-unattended", "backup", "recovery", "migration"] : allowed });
      setConfiguration(result); await load();
    } catch { setError("授权创建尚未确认。请先刷新授权列表核对，不要重复创建。"); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setBusy(true);
    try { await window.workspaceSetup.mcp("grant-revoke", { id }); await load(); }
    catch { setError("撤销结果尚不能确认，请刷新核对。"); }
    finally { setBusy(false); }
  }
  const labels: Record<string, string> = { succeeded: "已确认成功", failed: "失败", conflict: "冲突", unconfirmed: "结果待核对", "pending-confirmation": "等待用户确认", cancelled: "已取消" };
  return <section className="card" data-testid="mcp-management">
    <h2>MCP 接入管理</h2>
    <label>平台<select aria-label="MCP 平台" defaultValue="codex"><option value="codex">Codex</option></select></label>
    <button disabled={busy} onClick={() => {
      setBusy(true); setError("");
      void window.workspaceSetup.mcp("enable-codex", { platform: "codex" }).then(result => setCopyStatus((result as { message: string }).message)).catch(error => setError(error.message)).finally(() => setBusy(false));
    }}>一键开启 MCP</button>
    <p role="status">{copyStatus}</p>
    <p>默认开放当前及以后接入的所有空间和全部功能。使用时保持本应用运行。</p><p>为外部客户端创建具名授权，按领域及动作开放能力，随时撤销后续访问。</p>
    <details>
      <summary>MCP 使用方法（含 Codex 配置）</summary>
      <p>MCP 让 Codex 等外部 AI 查询和操作本工作空间。创建授权相当于发放一把限定领域与动作的钥匙；创建后还需在外部客户端完成配置。</p>
      <ol>
        <li>打开下方 MCP 管理，填写接入名称（例如 Codex），选择允许访问的领域。默认只读，需要新增、修改或完成待办时再勾选对应动作。</li>
        <li>创建接入授权，保存 credential。新凭据会在创建它的电脑上加密保存，可在当前授权列表显示和复制；旧授权未保存的凭据无法还原。</li>
        <li>确认服务地址：SSH 连接使用“服务器连接”底部显示的本机服务地址，通常为 http://127.0.0.1:43128，而不是服务器公网 IP。直接连接使用实际 HTTPS 服务地址。</li>
        <li>在授权列表点击“复制 Codex 配置”，粘贴到 Codex 用户配置 ~/.codex/config.toml，保留其他已有配置。复制内容已包含本机程序、服务地址和凭据，使用软件自带运行时，无需另外安装 Node.js。下方是手动使用 Node.js 的配置示例。</li>
      </ol>
      <pre style={{ overflowX: "auto", whiteSpace: "pre" }}>{`[mcp_servers.todo_workspace]
command = "node"
args = ["C:/你的程序目录/resources/app/apps/mcp/protocol/main.mjs"]

[mcp_servers.todo_workspace.env]
WORKSPACE_MCP_URL = "http://127.0.0.1:43128"
WORKSPACE_MCP_TOKEN = "替换为首次显示的 credential"`}</pre>
      <p>完全访问可自动注册新领域并操作未来新增领域，包含完整备份、独立目录恢复和迁移控制。恢复不覆盖原空间；迁移必须先停写原位置，再启用恢复目标，服务目录切换和重新授权仍需在目标环境完成。</p>
      <p>便携包使用 resources/app/apps/mcp/protocol/main.mjs；源码环境使用仓库下 apps/mcp/protocol/main.mjs 的绝对路径，并先安装项目依赖。Windows 路径可使用正斜杠。</p>
      <p>当前接入方式为 STDIO：由 Codex 启动 Node 脚本。WORKSPACE_MCP_URL 是脚本连接工作空间的地址，不要将它直接填为 HTTP MCP 地址。配置文件包含凭据，请妥善保管，不要提交到代码仓库；不要使用所有者凭据代替 credential。</p>
      <p>保存后重启 Codex 并开启新聊天，尝试“列出工作空间 MCP 工具，然后读取我的待办”。SSH 模式下保持本软件的 SSH 通道已连接。连接失败先检查通道、脚本路径和凭据；权限不足时核对领域与动作。可在下方查看调用记录或撤销授权，受限授权的删除仍需逐次确认，完全访问授权可自动删除。</p>
    </details>
    <button disabled={busy} onClick={() => { setOpened(!opened); if (!opened) void load(); }}>{opened ? "收起 MCP 管理" : "打开 MCP 管理"}</button>
    {opened && <><button disabled={busy} onClick={() => void load()}>刷新授权与调用记录</button>
      <fieldset disabled={busy}><legend>创建授权（默认只读）</legend>
        <label>接入名称<input value={name} onChange={e => setName(e.target.value)} /></label>
        <div>允许访问的领域</div>{domains.map(d => <label key={d.recordId}><input type="checkbox" checked={selected.includes(d.recordId)} onChange={e => setSelected(e.target.checked ? [...selected, d.recordId] : selected.filter(id => id !== d.recordId))} />{String((d.value?.definition as JsonObject)?.name ?? d.recordId)} · {d.recordId}</label>)}
        <label><input type="checkbox" checked={allDomains} onChange={e => setAllDomains(e.target.checked)} />所有领域（含未来新增，Agent 可自行决定注册领域 ID）</label><label><input type="checkbox" checked={fullAccess} onChange={e => setFullAccess(e.target.checked)} />完全访问：全部领域、内容操作、注册、备份恢复和迁移，删除无需逐次确认</label>
        <div>受限授权的动作（勾选完全访问后将授予全部动作）</div>{actions.map(([id, label]) => <label key={id}><input type="checkbox" checked={allowed.includes(id)} onChange={e => setAllowed(e.target.checked ? [...allowed, id] : allowed.filter(a => a !== id))} />{label}</label>)}
        <button disabled={!name.trim() || (!selected.length && !allDomains && !fullAccess)} onClick={() => void create()}>创建接入授权</button>
      </fieldset>
      {configuration !== null && <div data-testid="mcp-credential"><p>请将接入凭据保存到外部客户端配置；本机保存成功后也可从授权列表再次复制。WORKSPACE_MCP_URL 使用当前服务地址，WORKSPACE_MCP_TOKEN 使用 credential。</p><pre>{JSON.stringify(configuration, null, 2)}</pre><button onClick={() => setConfiguration(null)}>隐藏凭据</button></div>}
      <h3>当前授权</h3>{grants.map(g => <div key={g.id}><strong>{g.name}</strong><p>{g.domains.includes("*") ? "所有领域（含未来新增）" : g.domains.join("、")} · {g.actions.join("、")} · {g.revoked ? "已撤销" : "有效"}</p>{credentials[g.id] ? <div><code>{visible.includes(g.id) ? credentials[g.id] : "••••••••••••••••"}</code><button onClick={() => setVisible(visible.includes(g.id) ? visible.filter(id => id !== g.id) : [...visible, g.id])}>{visible.includes(g.id) ? "隐藏凭据" : "显示凭据"}</button><button onClick={async () => { try { await navigator.clipboard.writeText(credentials[g.id]!); setCopyStatus("凭据已复制" + (g.revoked ? "（已撤销，不可使用）" : "")); } catch { setCopyStatus("复制失败，请显示凭据后手动复制。"); } }}>复制凭据</button>{!g.revoked && <button onClick={async () => { try { const config = await window.workspaceSetup.mcp("configuration", { id: g.id }); await navigator.clipboard.writeText(String(config)); setCopyStatus("Codex 配置已复制，已填入本机程序路径、服务地址和凭据。"); } catch { setCopyStatus("无法复制配置，请检查连接与授权状态。"); } }}>复制 Codex 配置</button>}{g.revoked && <p>此凭据已撤销，不可继续访问。</p>}</div> : <p>本机未保存此授权的凭据；旧凭据无法还原，请重新创建。</p>}{!g.revoked && <button disabled={busy} onClick={() => void revoke(g.id)}>撤销 {g.name}</button>}</div>)}
      <h3>调用与授权记录</h3>{calls.length === 0 ? <p>尚无调用记录。</p> : calls.map(c => <article key={c.operationId}><strong>{c.sourceName} · {c.action} · {labels[c.status]}</strong><p>{c.summary}</p><small>{c.time} · {c.domainId} · {c.recordId} · {c.confirmed ? "已作具体确认" : "未作具体确认"}</small></article>)}
      </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
