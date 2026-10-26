import type { PullPage, SyncRemote, UploadRequest, UploadResult, WorkspaceIdentity } from "@workspace/contracts";
import { HttpWorkspaceLocation, workspaceServiceUrl } from "../workspace/http-location.js";

export class HttpSyncRemote implements SyncRemote {
  private readonly base: URL;
  constructor(url: string, private readonly token: string) { this.base = workspaceServiceUrl(url); }
  inspect(): Promise<WorkspaceIdentity | null> { return new HttpWorkspaceLocation(this.base.href, this.token).inspect(); }
  private async request(path: string, input: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.base), { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { authorization: "Bearer " + this.token, "content-type": "application/json" }, body: JSON.stringify(input) });
    if (response.status === 401 || response.status === 403) throw new Error("接入凭据无效或权限不足；本机内容保留，尚未同步。");
    if (!response.ok) throw new Error("统一位置未返回完整结果，请核对原操作；本机内容保留。");
    const text = await response.text();
    if (text.length > 16 * 1024 * 1024) throw new Error("同步响应过大，未推进本机进度。");
    return JSON.parse(text) as unknown;
  }
  async upload(request: UploadRequest): Promise<UploadResult> {
    if (request.batch !== undefined) {
      const capability = await this.request("v1/sync/capabilities", {}) as { atomicProtocol?: number };
      if (capability.atomicProtocol !== 1) throw new Error("统一位置尚不支持整体操作，请升级服务后接续；本机成果保留。");
    }
    const result = await this.request("v1/sync/upload", request) as UploadResult;
    if (!["accepted", "conflict", "rejected"].includes(result?.status)) throw new Error("无法核对统一位置回执。");
    if (result.status !== "rejected" && (!result.version || result.version.workspaceId !== request.workspaceId || result.version.domainId !== request.domainId || ![request.recordId,...(request.batch??[]).map(r=>r.recordId)].includes(result.version.recordId) || !Number.isSafeInteger(result.version.revision) || result.version.revision < 1)) throw new Error("回执身份不匹配，原操作保留。");
    if (result.status === "accepted" && (result.version.revision <= request.baseRevision || !Array.isArray(result.version.changed))) throw new Error("确认进度回执无效，原操作保留。");
    if (result.status === "rejected" && typeof result.message !== "string") throw new Error("拒绝结果不完整，原操作保留。");
    return result;
  }
  async pull(workspaceId: string, authorityId: string, cursor: number): Promise<PullPage> {
    const result = await this.request("v1/sync/pull", { workspaceId, authorityId, cursor, atomicProtocol: 1 }) as PullPage;
    if (!Array.isArray(result?.versions) || !Number.isSafeInteger(result.cursor) || result.cursor < cursor || typeof result.more !== "boolean") throw new Error("进度响应不完整，游标保留。");
    let prior = cursor;
    for (const version of result.versions) {
      if (version.workspaceId !== workspaceId || typeof version.domainId !== "string" || typeof version.recordId !== "string" ||
          !Number.isSafeInteger(version.revision) || version.revision <= prior || !Array.isArray(version.changed) ||
          (version.value !== null && (!version.value || typeof version.value !== "object" || Array.isArray(version.value)))) throw new Error("进度响应身份或顺序无效，游标保留。");
      prior = version.revision;
    }
    if (prior !== result.cursor || (result.more && !result.versions.length)) throw new Error("进度分页不完整，游标保留。");
    return result;
  }
}
