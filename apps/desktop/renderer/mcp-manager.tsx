import { useState } from "react";
import type { AuthorityVersion, McpCall, McpGrant, JsonObject } from "@workspace/contracts";

const actions: [string, string][] = [["read", "内容查询"], ["create", "新增内容"], ["update", "修改内容"], ["date", "设置日期"], ["complete", "完成待办"], ["restore", "恢复未完成"], ["delete", "删除（逐次确认）"], ["directory", "领域目录"], ["register", "注册领域"], ["enable", "启用领域"], ["disable", "停用领域"], ["install", "补齐服务器程序"], ["remove", "移除服务器程序"]];
export function McpManager() {
  const [opened, setOpened] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [grants, setGrants] = useState<McpGrant[]>([]), [calls, setCalls] = useState<McpCall[]>([]), [domains, setDomains] = useState<AuthorityVersion[]>([]);
  const [name, setName] = useState(""), [selected, setSelected] = useState<string[]>([]), [allowed, setAllowed] = useState(["read"]), [newDomain, setNewDomain] = useState("");
  const [configuration, setConfiguration] = useState<unknown>(null);
  async function load() {
    setBusy(true); setError("");
    try {
      setGrants(await window.workspaceSetup.mcp("grants") as McpGrant[]);
      setCalls(await window.workspaceSetup.mcp("calls") as McpCall[]);
      setDomains(await window.workspaceSetup.mcp("directory") as AuthorityVersion[]);
    } catch { setError("统一位置暂不可达，无法核对授权与调用记录。请恢复连接后刷新。"); }
    finally { setBusy(false); }
  }
  async function create() {
    setBusy(true); setError("");
    try {
      const result = await window.workspaceSetup.mcp("grant-create", { name, domains: [...selected, ...(newDomain.trim() ? [newDomain.trim()] : [])], actions: allowed });
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
    <h2>MCP 接入管理</h2><p>为外部客户端创建具名授权，按领域及动作开放能力，随时撤销后续访问。</p>
    <button disabled={busy} onClick={() => { setOpened(!opened); if (!opened) void load(); }}>{opened ? "收起 MCP 管理" : "打开 MCP 管理"}</button>
    {opened && <><button disabled={busy} onClick={() => void load()}>刷新授权与调用记录</button>
      <fieldset disabled={busy}><legend>创建授权（默认只读）</legend>
        <label>接入名称<input value={name} onChange={e => setName(e.target.value)} /></label>
        <div>允许访问的领域</div>{domains.map(d => <label key={d.recordId}><input type="checkbox" checked={selected.includes(d.recordId)} onChange={e => setSelected(e.target.checked ? [...selected, d.recordId] : selected.filter(id => id !== d.recordId))} />{String((d.value?.definition as JsonObject)?.name ?? d.recordId)} · {d.recordId}</label>)}
        <label>新领域身份（仅注册授权）<input value={newDomain} onChange={e => setNewDomain(e.target.value)} /></label>
        <div>明确授予的动作</div>{actions.map(([id, label]) => <label key={id}><input type="checkbox" checked={allowed.includes(id)} onChange={e => setAllowed(e.target.checked ? [...allowed, id] : allowed.filter(a => a !== id))} />{label}</label>)}
        <button disabled={!name.trim() || (!selected.length && !newDomain.trim())} onClick={() => void create()}>创建接入授权</button>
      </fieldset>
      {configuration !== null && <div data-testid="mcp-credential"><p>接入凭据仅此次显示，请保存到外部客户端配置。WORKSPACE_MCP_URL 使用当前服务地址，WORKSPACE_MCP_TOKEN 使用 credential。</p><pre>{JSON.stringify(configuration, null, 2)}</pre><button onClick={() => setConfiguration(null)}>隐藏凭据</button></div>}
      <h3>当前授权</h3>{grants.map(g => <div key={g.id}><strong>{g.name}</strong><p>{g.domains.join("、")} · {g.actions.join("、")} · {g.revoked ? "已撤销" : "有效"}</p>{!g.revoked && <button disabled={busy} onClick={() => void revoke(g.id)}>撤销 {g.name}</button>}</div>)}
      <h3>调用与授权记录</h3>{calls.length === 0 ? <p>尚无调用记录。</p> : calls.map(c => <article key={c.operationId}><strong>{c.sourceName} · {c.action} · {labels[c.status]}</strong><p>{c.summary}</p><small>{c.time} · {c.domainId} · {c.recordId} · {c.confirmed ? "已作具体确认" : "未作具体确认"}</small></article>)}
      {error && <p role="alert">{error}</p>}</>}
  </section>;
}
