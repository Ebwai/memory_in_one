import { canonical, type AuthorityPersistence, type JsonObject, type McpCall, type McpGrant, type McpPrepared, type UploadRequest } from "@workspace/contracts";
import { McpAccess, type McpStore } from "./grants.js";
import type { AuthorityService } from "../operations/authority-service.js";

export class McpOperations {
  constructor(private readonly workspaceId: string, private readonly access: McpAccess, private readonly store: McpStore & AuthorityPersistence,
    private readonly authority: AuthorityService, private readonly prepare: (input: JsonObject, audit: McpCall) => Promise<UploadRequest>, private readonly now: () => string) {}
  async write(grant: McpGrant, input: JsonObject): Promise<unknown> {
    const domainId = String(input.domainId ?? ""), action = String(input.action ?? "");
    this.access.require(grant, domainId, action);
    if (typeof input.operationId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.operationId) || Object.hasOwn(input, "confirmed")) throw new Error("请提供稳定的原调用身份；具体确认不能由工具参数声明。");
    const operationId = grant.id + ":" + input.operationId;
    const key = canonical(input);
    let prepared = await this.store.mcp<McpPrepared | null>({ method: "prepared", workspaceId: this.workspaceId, operationId });
    let audit: McpCall = { workspaceId: this.workspaceId, operationId, sourceId: grant.id, sourceName: grant.name, domainId, action,
      recordId: String(input.recordId ?? ""), summary: action + " · " + String(input.recordId ?? "新内容"), time: this.now(), confirmed: false, status: "unconfirmed", result: {} };
    if (prepared && prepared.key !== key) throw new Error("原调用身份不能改为另一动作或内容。");
    if (!prepared) {
      const previous = await this.store.mcp<McpCall | null>({ method: "call-read", workspaceId: this.workspaceId, operationId });
      if (previous) return previous;
      try {
        const request = await this.prepare(input, audit);
        audit = request.audit!;
        prepared = await this.store.mcp<McpPrepared>({ method: "prepare", prepared: { key, request, challenge: action === "delete" ? operationId : null, confirmation: action === "delete" ? "pending" : "unneeded" } });
      } catch (error) {
        await this.store.mcp({ method: "call-save", call: { ...audit, status: "failed", result: { message: error instanceof Error ? error.message : "参数无效。" } } });
        throw error;
      }
    }
    if (prepared.confirmation === "pending") return { status: "pending-confirmation", operationId, challenge: prepared.challenge, object: prepared.request.audit?.summary, domainId, recordId: prepared.request.recordId, revision: prepared.request.baseRevision, confirmationPath: "/manage#confirmation=" + encodeURIComponent(operationId) };
    if (prepared.confirmation === "declined") return { status: "cancelled", operationId };
    const recorded = await this.store.mcp<McpCall | null>({ method: "call-read", workspaceId: this.workspaceId, operationId });
    if (recorded && ["failed", "conflict", "cancelled"].includes(recorded.status)) return recorded.result;
    const prior = await this.store.authorityReceipt(prepared.request);
    if (prior) return prior;
    const result = await this.authority.upload(prepared.request);
    if (result.status !== "accepted") await this.store.mcp({ method: "call-save", call: { ...prepared.request.audit!, status: result.status === "conflict" ? "conflict" : "failed", result: JSON.parse(JSON.stringify(result)) as JsonObject } });
    return result;
  }
}
