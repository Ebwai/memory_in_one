import { prepareTodo, prepareTodoMutation, prepareTodoTree, todoSubtreeBasis, TODO_DOMAIN } from "@workspace/todo-list";
import { parseExtension, validateExtensionRecord } from "@workspace/extension-sdk";
import { canonical, type McpPrepared, type ContentValue, type DomainRegistration, type UploadRequest } from "@workspace/contracts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { SqliteLocalStore, SqliteWorkspaceAuthority } from "@workspace/adapters";
import { DOMAIN_REGISTRY, McpAccess, McpQueries, McpOperations, AuthorityService, describeExportScope, prepareDomainRegistration, prepareDomainEnabled } from "@workspace/core";
import { type JsonObject, type McpGrant } from "@workspace/contracts";
import { WorkspaceSync } from "./workspace-sync.js";

export class WorkspaceMcp {
  constructor(private readonly directory: string) {}
  async execute(owner: boolean, secret: string, method: string, input: JsonObject): Promise<unknown> {
    const identity = await new SqliteWorkspaceAuthority(this.directory).inspect();
    if (!identity) throw new Error("工作空间尚未初始化。");
    const store = await SqliteLocalStore.open({ databasePath: join(this.directory, "workspace.sqlite") });
    try {
      const access = new McpAccess(identity.workspaceId, store, () => new Date().toISOString());
      if (owner) {
        if (method === "confirmation" || method === "owner-confirmation") {
          const prepared = await store.mcp<McpPrepared | null>({ method: "prepared", workspaceId: identity.workspaceId, operationId: String(input.operationId) });
          if (!prepared || prepared.confirmation !== "pending") throw new Error("原操作不存在或不再等待确认。");
          if (method === "confirmation") return { workspace: identity, source: prepared.request.audit?.sourceName, object: prepared.request.audit?.summary, domainId: prepared.request.domainId, recordId: prepared.request.recordId, revision: prepared.request.baseRevision };
          if (typeof input.accepted !== "boolean") throw new Error("请选择具体确认或取消。");
          return await store.mcp({ method: "confirm", workspaceId: identity.workspaceId, operationId: prepared.request.operationId, challenge: prepared.challenge!, accepted: input.accepted });
        }
        if (method === "migration-status" || method === "migration-stop" || method === "migration-activate") return await store.authorityControl(identity.workspaceId, identity.authorityId, method === "migration-status" ? "status" : method === "migration-stop" ? "stop" : "activate", input.isolated === true);
        if (method === "export-snapshot") return { workspace: identity, location: "统一位置", snapshot: await store.snapshot(identity.workspaceId, "authority") };
        if (method === "export-scope") return describeExportScope(identity, "authority", "统一位置", await store.exportInventory(identity.workspaceId, "authority"), new Date().toISOString());
        if (method === "grants") return await store.mcp({ method: "grant-list", workspaceId: identity.workspaceId });
        if (method === "calls") return await store.mcp({ method: "call-list", workspaceId: identity.workspaceId });
        if (method === "grant-create") {
          const domains = input.domains;
          if (!Array.isArray(domains) || !domains.every(d => typeof d === "string")) throw new Error("请选择领域。");
          const registrations = await store.authorityList(identity.workspaceId, DOMAIN_REGISTRY);
          if (domains.some(d => !registrations.some(r => r.recordId === d)) && !(Array.isArray(input.actions) && input.actions.includes("register"))) throw new Error("授权领域尚未登记。");
          if (input.actions !== undefined && (!Array.isArray(input.actions) || !input.actions.every(a => typeof a === "string"))) throw new Error("授权动作无效。");
          const credential = randomBytes(32).toString("base64url");
          const grant = await access.create(randomUUID(), String(input.name ?? ""), domains as string[], input.actions as string[] | undefined, createHash("sha256").update(credential).digest("hex"));
          return { grant, credential, workspace: identity };
        }
        if (method === "grant-revoke") return await access.revoke(String(input.id ?? ""));
        if (method === "directory") return await store.authorityList(identity.workspaceId, DOMAIN_REGISTRY);
        throw new Error("所有者管理动作不可用。");
      }
      const grant: McpGrant = await access.authenticate(createHash("sha256").update(secret).digest("hex"));
      const available = (domainId: string) => {
        if (domainId === DOMAIN_REGISTRY) throw new Error("内部登记不属于内容查询。");
        return new WorkspaceSync(this.directory).handler(store, identity.workspaceId, domainId);
      };
      if (method === "directory") {
        if (!grant.actions.includes("directory")) throw new Error("未授予领域管理查询。");
        const records = await store.authorityList(identity.workspaceId, DOMAIN_REGISTRY);
        return await Promise.all(records.filter(r => grant.domains.includes(r.recordId)).map(async r => ({ ...r, programAvailable: r.recordId === TODO_DOMAIN || await store.mcp<boolean>({ method: "host-get", workspaceId: identity.workspaceId, domainId: r.recordId }), programTarget: "server" })));
      }
      if (method === "program") {
        const domainId = String(input.domainId), action = String(input.action);
        access.require(grant, domainId, action);
        if (!["install", "remove"].includes(action) || input.target !== "server") return { status: "unavailable", message: "此通道仅管理服务器程序，不能操作其他客户端。", target: "server" };
        if (domainId === TODO_DOMAIN) throw new Error("内置程序不能单独安装或移除。");
        if (typeof input.operationId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.operationId)) throw new Error("缺少原调用身份。");
        const registration = await store.authorityRead({ workspaceId: identity.workspaceId, domainId: DOMAIN_REGISTRY, recordId: domainId });
        if (!registration?.value) throw new Error("领域未登记。");
        if (action === "install") {
          const definition = parseExtension(JSON.stringify(input.definition));
          if (canonical(definition) !== canonical((registration.value as unknown as DomainRegistration).definition)) throw new Error("补齐材料与原领域不兼容。");
        }
        return await store.mcp({ method: "host-set", workspaceId: identity.workspaceId, domainId, available: action === "install",
          audit: { workspaceId: identity.workspaceId, operationId: grant.id + ":" + input.operationId, sourceId: grant.id, sourceName: grant.name, domainId, action, recordId: domainId,
            summary: action + " · " + domainId + "（仅服务器）", time: new Date().toISOString(), confirmed: false, status: "succeeded", result: { status: "accepted", target: "server", available: action === "install" } } });
      }
      if (method === "write") return await new McpOperations(identity.workspaceId, access, store,
        new AuthorityService(identity, store, id => id === DOMAIN_REGISTRY ? new WorkspaceSync(this.directory).handler(store, identity.workspaceId, id) : available(id)),
        async (raw, audit): Promise<UploadRequest> => {
          const domainId = String(raw.domainId), action = String(raw.action);
          if (["register", "enable", "disable"].includes(action)) {
            const scope = { workspaceId: identity.workspaceId, domainId: DOMAIN_REGISTRY, recordId: domainId };
            const current = await store.authorityRead(scope);
            const old = current?.value as unknown as DomainRegistration | null;
            let value: DomainRegistration;
            if (action === "register") {
              const definition = parseExtension(JSON.stringify(raw.definition));
              if (definition.domainId !== domainId) throw new Error("程序与授权领域身份不匹配。");
              value = prepareDomainRegistration(old, definition, createHash("sha256").update(JSON.stringify(definition)).digest("hex"));
            } else {
              if (!old || Number(raw.revision) !== current?.revision) throw new Error("领域进度已变化，请重新查询。");
              value = prepareDomainEnabled(old, action === "enable", await store.mcp<boolean>({ method: "host-get", workspaceId: identity.workspaceId, domainId }));
            }
            return { ...scope, authorityId: identity.authorityId, operationId: audit.operationId, baseRevision: current?.revision ?? 0,
              value: value as unknown as JsonObject, changed: ["enabled"], resolution: false, audit: { ...audit, recordId: domainId, summary: action + " · " + domainId + "（工作空间）" } };
          }
          const recordId = action === "create" ? randomUUID() : String(raw.recordId ?? "");
          const current = action === "create" ? null : await store.authorityRead({ workspaceId: identity.workspaceId, domainId, recordId });
          if (action !== "create" && !current?.value) throw new Error("原内容不存在或已删除。");
          if (action !== "create" && (!Number.isSafeInteger(raw.revision) || Number(raw.revision) <= 0)) throw new Error("请提供读取到的原进度。");
          const base = action === "create" ? null : await store.authorityRead({ workspaceId: identity.workspaceId, domainId, recordId }, Number(raw.revision));
          if (action !== "create" && !base?.value) throw new Error("原读取依据不存在。");
          const handler = await available(domainId);
          let value: ContentValue;
          let batch: UploadRequest[] | undefined;
          if (domainId === TODO_DOMAIN) {
            if (action === "create") value = prepareTodo(raw.text, audit.time);
            else {
              const command = action === "update" ? { kind: "text", text: raw.text } : action === "date" ? { kind: "date", dueDate: raw.dueDate } :
                action === "complete" || action === "restore" ? { kind: "complete", completed: action === "complete" } : action === "delete" ? { kind: "delete", confirmed: true } : null;
              if (!command) throw new Error("待办未提供此动作。");
              if (action==="update" || action==="date") {
                const mutation = prepareTodoMutation(base!.value!,command,audit.time);
                value = mutation.kind==="delete" ? null : mutation.payload;
              } else {
              const versions = await store.authorityList(identity.workspaceId,domainId);
              if (current?.revision !== base?.revision) throw new Error("原事项进度已变化，请重新查询后操作。");
              const rows = versions.map(v=>({workspaceId:v.workspaceId,domainId:v.domainId,recordId:v.recordId,localSequence:v.revision,deleted:v.value===null,payload:v.value}));
              const prepared = prepareTodoTree(rows,recordId,command.kind==="delete" ? {...command,subtreeBasis:todoSubtreeBasis(rows,recordId)} as import("@workspace/todo-list").TodoCommand : command as import("@workspace/todo-list").TodoCommand,audit.time);
              value = prepared[0]!.value;
              batch = prepared.slice(1).map(item=>({...identity,domainId,recordId:item.recordId,operationId:audit.operationId+"~"+item.recordId,baseRevision:versions.find(v=>v.recordId===item.recordId)!.revision,value:item.value,
                changed:Object.entries(handler.policy?.attributes??{}).filter(([,keys])=>keys.some(k=>canonical(versions.find(v=>v.recordId===item.recordId)?.value?.[k])!==canonical(item.value?.[k]))).map(([key])=>key),resolution:false}));
              if(action==="delete" && prepared.length>1) audit={...audit,summary:"删除父事项及全部 "+(prepared.length-1)+" 条子待办 · "+String(current?.value?.text??recordId).slice(0,200)};
              }
            }
          } else {
            const registration = await store.authorityRead({ workspaceId: identity.workspaceId, domainId: DOMAIN_REGISTRY, recordId: domainId });
            const definition = parseExtension(JSON.stringify((registration!.value as unknown as DomainRegistration).definition));
            if (!["create", "update", "delete"].includes(action) || !definition.actions.includes(action as "create")) throw new Error("领域未声明此动作。");
            value = action === "delete" ? null : raw.payload as JsonObject;
            if (value !== null) validateExtensionRecord(definition, value);
          }
          handler.validate(value, base?.value ?? null, current === null);
          const changed = Object.entries(handler.policy?.attributes ?? {}).filter(([, keys]) => keys.some(k => canonical(base?.value?.[k]) !== canonical(value?.[k]))).map(([a]) => a);
          return { workspaceId: identity.workspaceId, authorityId: identity.authorityId, domainId, recordId, operationId: audit.operationId,
            baseRevision: base?.revision ?? 0, value, changed, resolution: false, ...(batch ? {batch} : {}),
            audit: { ...audit, recordId, summary: batch?.length && action==="delete" ? audit.summary : action + " · " + String(current?.value?.text ?? current?.value?.title ?? raw.text ?? recordId).slice(0, 256), status: action === "delete" ? "pending-confirmation" : "unconfirmed" } };
        }, () => new Date().toISOString()).write(grant, input);
      if (method === "respond-confirmation") {
        const prepared = await store.mcp<McpPrepared | null>({ method: "prepared", workspaceId: identity.workspaceId, operationId: String(input.operationId) });
        if (!prepared || prepared.request.audit?.sourceId !== grant.id || typeof input.accepted !== "boolean") throw new Error("确认对象或来源无效。");
        return await store.mcp({ method: "confirm", workspaceId: identity.workspaceId, operationId: String(input.operationId), challenge: String(input.challenge), accepted: input.accepted });
      }
      if (method === "list" || method === "get") return await new McpQueries(identity.workspaceId, access, store, available).read(grant, String(input.domainId ?? ""), method === "get" ? String(input.recordId ?? "") : undefined);
      if (method === "status") {
        const call = await store.mcp<import("@workspace/contracts").McpCall | null>({ method: "call-read", workspaceId: identity.workspaceId, operationId: String(input.operationId ?? "").startsWith(grant.id + ":") ? String(input.operationId) : grant.id + ":" + String(input.operationId ?? "") });
        if (call && call.sourceId !== grant.id) throw new Error("不能读取其他来源调用。");
        return call ?? { status: "not-found" };
      }
      if (method === "tools") {
        const domains: string[] = [];
        for (const id of grant.domains) { try { await available(id); domains.push(id); } catch {} }
        const capabilities: Record<string, readonly string[]> = {};
        for (const id of domains) {
          const r = await store.authorityRead({ workspaceId: identity.workspaceId, domainId: DOMAIN_REGISTRY, recordId: id });
          capabilities[id] = id === TODO_DOMAIN ? ["create", "update", "date", "complete", "restore", "delete"] : (r?.value as unknown as DomainRegistration).definition.actions;
        }
        return { workspace: identity, grant: { name: grant.name, actions: grant.actions }, authorizedDomains: grant.domains, domains, capabilities };
      }
      throw new Error("工具不可用。");
    } finally { await store.close(); }
  }
}
