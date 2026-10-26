import type { WorkspaceCreateResult, WorkspaceCreationPort, WorkspaceIdentity, WorkspaceProposal } from "@workspace/contracts";

export function workspaceServiceUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use HTTPS, or HTTP on the current computer");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}
function isIdentity(value: unknown): value is WorkspaceIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as WorkspaceIdentity;
  return [identity.workspaceId, identity.authorityId, identity.name, identity.creationId, identity.createdAt]
    .every((item) => typeof item === "string" && item.length > 0) &&
    [identity.workspaceId, identity.authorityId, identity.creationId].every((id) => /^[a-zA-Z0-9_-]{1,128}$/.test(id));
}
export class HttpWorkspaceLocation implements WorkspaceCreationPort {
  private readonly base: URL;
  constructor(url: string, private readonly token: string) { this.base = workspaceServiceUrl(url); }
  async create(proposal: WorkspaceProposal): Promise<WorkspaceCreateResult> {
    try {
      const response = await fetch(new URL("v1/initialize", this.base), { method: "POST", redirect: "error",
        headers: { authorization: "Bearer " + this.token, "content-type": "application/json" },
        body: JSON.stringify({ creationId: proposal.creationId, name: proposal.name }), signal: AbortSignal.timeout(5000) });
      if (response.status === 401) return { status: "rejected", reason: "unauthorized", message: "接入凭据无效，请核对服务器配置。" };
      const result = await response.json() as WorkspaceCreateResult;
      if (result.status === "created" && (!response.ok || !isIdentity(result.workspace) || result.workspace.creationId !== proposal.creationId || result.workspace.name !== proposal.name)) throw new Error("Unverified identity");
      if (!["created", "rejected", "unconfirmed"].includes(result.status)) throw new Error("Unexpected response");
      if (result.status !== "created" && typeof result.message !== "string") throw new Error("Unusable result");
      return result;
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      if (cause && ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(cause)) {
        return { status: "rejected", reason: "unavailable", message: "服务器不可达，请保留填写内容并检查地址与服务状态。" };
      }
      return { status: "unconfirmed", message: "服务器暂不可达或结果未完整返回，请保留原请求后再次核对。" };
    }
  }
  async inspect(): Promise<WorkspaceIdentity | null> {
    const response = await fetch(new URL("v1/identity", this.base), { redirect: "error",
      headers: { authorization: "Bearer " + this.token }, signal: AbortSignal.timeout(5000) });
    if (response.status === 401 || response.status === 403) throw new Error("接入凭据无效或权限不足，请核对服务器配置。");
    if (!response.ok) throw new Error("无法读取空间身份，请检查地址与服务状态。");
    const identity: unknown = await response.json();
    if (identity === null) return null;
    if (!isIdentity(identity)) throw new Error("Unrecognized workspace identity");
    return identity;
  }
}

