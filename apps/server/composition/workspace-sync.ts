import { createHash } from "node:crypto";
import { join } from "node:path";
import { SqliteLocalStore, SqliteWorkspaceAuthority } from "@workspace/adapters";
import { AuthorityService, DOMAIN_REGISTRY } from "@workspace/core";
import { parseExtension, validateExtensionRecord } from "@workspace/extension-sdk";
import { todoConflictPolicy, todoDefinition, TODO_DOMAIN, validateTodoConflict, validateTodoTree } from "@workspace/todo-list";
import { canonical } from "@workspace/contracts";
import type { ContentValue, DomainHandler, DomainRegistration, JsonObject, UploadRequest } from "@workspace/contracts";

export class WorkspaceSync {
  constructor(private readonly directory: string) {}
  async handler(store: SqliteLocalStore, workspaceId: string, domainId: string): Promise<DomainHandler> {
    if (domainId === DOMAIN_REGISTRY) {
      const validate = (value: ContentValue, base: ContentValue) => {
        if (!value || typeof value.enabled !== "boolean" || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
            Object.keys(value).some((key) => !["definition", "fingerprint", "enabled"].includes(key))) throw new Error("领域登记格式无效。");
        if (value.fingerprint !== createHash("sha256").update(JSON.stringify(value.definition)).digest("hex")) throw new Error("领域程序指纹与声明不一致。");
        if ((value.definition as JsonObject)?.domainId === TODO_DOMAIN) {
          if (canonical(value.definition) !== canonical(todoDefinition)) throw new Error("待办程序声明不兼容。");
        } else parseExtension(JSON.stringify(value.definition));
        if (base && (canonical(value.definition) !== canonical(base.definition) || value.fingerprint !== base.fingerprint)) throw new Error("不能通过同步覆盖已有领域程序或版本。");
      };
      return { validate, guards: [], policy: { attributes: { enabled: ["enabled"] }, validate } };
    }
    const registration = await store.authorityRead({ workspaceId, domainId: DOMAIN_REGISTRY, recordId: domainId });
    const value = registration?.value as unknown as DomainRegistration | null;
    if (!registration || !value?.enabled || value.definition.domainId !== domainId) throw new Error("统一位置的领域未登记或已停用，本机成果保留。");
    if (domainId === TODO_DOMAIN) return { policy: todoConflictPolicy, guards: [registration], validate: validateTodoConflict, validateCollection: validateTodoTree };
    if (!await store.mcp<boolean>({ method: "host-get", workspaceId, domainId })) throw new Error("服务器缺少该领域兼容程序，原数据保留。");
    const definition = parseExtension(JSON.stringify(value.definition));
    return { guards: [registration], validate: (payload, base, creating) => {
      if (!definition.actions.includes(payload === null ? "delete" : creating ? "create" : "update")) throw new Error("领域未声明此动作。");
      if (payload !== null) validateExtensionRecord(definition, payload);
      if (base === null && !creating && payload !== null) throw new Error("自定义领域不支持此恢复结果。");
    } };
  }
  async execute(method: "upload" | "pull", raw: unknown): Promise<unknown> {
    const identity = await new SqliteWorkspaceAuthority(this.directory).inspect();
    if (!identity) throw new Error("工作空间尚未初始化。");
    const input = raw as JsonObject;
    if (!input || input.workspaceId !== identity.workspaceId || input.authorityId !== identity.authorityId) throw new Error("空间或权威身份不匹配。");
    const store = await SqliteLocalStore.open({ databasePath: join(this.directory, "workspace.sqlite") });
    try {
      if (method === "pull") {
        if (!Number.isSafeInteger(input.cursor) || Number(input.cursor) < 0) throw new Error("进度游标无效。");
        const page = await store.authorityPull(identity.workspaceId, Number(input.cursor));
        if (input.atomicProtocol !== 1 && page.versions.some(v=>v.related?.length)) throw new Error("客户端尚不支持整棵树的进度，请升级后重新获取。");
        return page;
      }
      const { audit: _untrustedAudit, ...clean } = raw as UploadRequest;
      const request: UploadRequest = clean;
      if (request.domainId === DOMAIN_REGISTRY && request.value && (request.value.definition as JsonObject)?.domainId !== request.recordId) throw new Error("领域登记身份不一致。");
      return await new AuthorityService(identity, store, (domainId) => this.handler(store, identity.workspaceId, domainId)).upload(request);
    } finally { await store.close(); }
  }
}
