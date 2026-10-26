import type { McpCall, McpGrant, McpStorageCommand } from "@workspace/contracts";

export interface McpStore { mcp<T = unknown>(command: McpStorageCommand): Promise<T> }
export const MCP_ACTIONS = ["read", "create", "update", "date", "complete", "restore", "delete", "directory", "register", "enable", "disable", "install", "remove"] as const;

export class McpAccess {
  constructor(private readonly workspaceId: string, private readonly store: McpStore, private readonly now: () => string) {}
  async create(id: string, name: string, domains: readonly string[], actions: readonly string[] | undefined, secretHash: string): Promise<McpGrant> {
    const selected = actions ?? ["read"];
    if (!id || !name.trim() || name.length > 128 || !domains.length || domains.some(d => !d.trim()) || !selected.length || selected.some(a => !MCP_ACTIONS.includes(a as typeof MCP_ACTIONS[number])) || !/^[a-f0-9]{64}$/.test(secretHash)) throw new Error("授权名称、领域或动作范围无效。");
    const grant: McpGrant = { workspaceId: this.workspaceId, id, name: name.trim(), domains: [...new Set(domains)], actions: [...new Set(selected)], revoked: false };
    await this.store.mcp({ method: "grant-create", grant, secretHash, audit: this.audit(grant, "grant-create") });
    return grant;
  }
  async revoke(id: string): Promise<unknown> {
    const grants = await this.store.mcp<McpGrant[]>({ method: "grant-list", workspaceId: this.workspaceId });
    const grant = grants.find(g => g.id === id); if (!grant) throw new Error("授权不存在。");
    return this.store.mcp({ method: "grant-revoke", workspaceId: this.workspaceId, id, audit: this.audit(grant, "grant-revoke") });
  }
  async authenticate(secretHash: string): Promise<McpGrant> {
    const grant = await this.store.mcp<McpGrant | null>({ method: "grant-auth", workspaceId: this.workspaceId, secretHash });
    if (!grant) throw new Error("接入未授权或已撤销。"); return grant;
  }
  require(grant: McpGrant, domainId: string, action: string): void {
    if (grant.workspaceId !== this.workspaceId || grant.revoked || !grant.domains.includes(domainId) || !grant.actions.includes(action)) throw new Error("当前授权不允许此领域或动作。");
  }
  private audit(grant: McpGrant, action: string): McpCall {
    return { workspaceId: this.workspaceId, operationId: action + ":" + grant.id, sourceId: "owner", sourceName: "工作空间所有者", domainId: "workspace.access", action, recordId: grant.id, summary: grant.name, time: this.now(), confirmed: true, status: "succeeded", result: { grantId: grant.id } };
  }
}
