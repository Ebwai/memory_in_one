import { createHash } from "node:crypto";
import { CollectionContentService } from "@workspace/core";
import { canonical } from "@workspace/contracts";
import { prepareTodoTree } from "@workspace/todo-list";
import type { TodoCommand } from "@workspace/todo-list";
import { LocalStoreError } from "@workspace/contracts";
import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { todoDefinition, TODO_DOMAIN, prepareTodo, todoConflictPolicy } from "@workspace/todo-list";
import { ConflictService, LocalContentService, DomainRegistry } from "@workspace/core";
import { FileExtensionPrograms, SqliteLocalStore } from "@workspace/adapters";
import { parseExtension, validateExtensionRecord } from "@workspace/extension-sdk";
import type { JsonObject } from "@workspace/contracts";
import type { WorkspaceBinding } from "../bridge/workspace-contracts.js";

export function installDomainFeatures(check: (event: IpcMainInvokeEvent) => void, current: () => WorkspaceBinding | null, base: () => string, onSaved: () => void = () => undefined): void {
  let queue = Promise.resolve();
  ipcMain.handle("workspace:domains", async (event, raw: unknown) => {
    check(event);
    const preceding = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => { release = resolve; });
    await preceding;
    const binding = current();
    if (!binding) { release(); return { ok: false, message: "请先创建或接入工作空间。" }; }
    let store: SqliteLocalStore | undefined;
    let writeAttempt = false;
    try {
      const request = raw as { draft?: JsonObject; generation?: number; choice?: import("@workspace/contracts").ResolutionChoice; submitted?: boolean; action: string; source?: string; operationId?: string; domainId?: string; recordId?: string; text?: string; createdAt?: string; payload?: JsonObject; workspaceId?: string; baseSequence?: number; command?: unknown; at?: string };
      if (!request || typeof request.action !== "string") throw new Error("无效的领域请求。");
      writeAttempt = ["todo-progress", "todo-create", "todo-recover", "save-record", "delete-record", "enable", "disable", "register", "conflict-choice"].includes(request.action);
      store = await SqliteLocalStore.open({ databasePath: binding.replicaPath });
      const registry = new DomainRegistry(binding.workspace.workspaceId, store, new FileExtensionPrograms(join(base(), "programs", binding.workspace.workspaceId)), (definition) => definition.domainId !== TODO_DOMAIN);
      if (request.action === "preview") {
        if (typeof request.source !== "string") throw new Error("请提供扩展 JSON。");
        return { ok: true, preview: parseExtension(request.source) };
      }
      if (request.action === "editor-save" || request.action === "editor-clear") {
        const domainId = request.domainId ?? TODO_DOMAIN;
        if (typeof request.recordId !== "string") throw new Error("原编辑内容身份无效。");
        const scope = { workspaceId: binding.workspace.workspaceId, domainId, recordId: request.recordId };
        if (request.action === "editor-clear") await store.clearEditor(scope);
        else {
          if (!request.draft || typeof request.draft !== "object" || Array.isArray(request.draft) || typeof request.baseSequence !== "number" || typeof request.operationId !== "string") throw new Error("编辑保护材料无效。");
          await registry.contentStore(domainId);
          await store.saveEditor({ ...scope, value: request.draft, baseSequence: request.baseSequence, operationId: request.operationId });
        }
        return { ok: true };
      }
      if (request.action === "conflict-list" || request.action === "conflict-choice") {
        const domainId = request.domainId ?? TODO_DOMAIN;
        const domain = await registry.get(domainId);
        if (!domain.enabled || !domain.programAvailable) throw new Error("请先启用领域并补齐兼容程序；冲突材料保留。");
        const scope = { workspaceId: binding.workspace.workspaceId, domainId };
        const conflictPolicy = domainId === TODO_DOMAIN ? todoConflictPolicy : { attributes: {}, validate: (value: import("@workspace/contracts").ContentValue) => { if (value !== null) validateExtensionRecord(domain.definition, value); } };
        if (request.action === "conflict-list") return { ok: true, conflicts: await store.listConflicts(scope) };
        if (typeof request.recordId !== "string" || typeof request.generation !== "number" ||
            typeof request.operationId !== "string" || !request.choice || typeof request.submitted !== "boolean") throw new Error("选择依据不完整，原冲突保留。");
        try {
          const conflict = await new ConflictService(store, conflictPolicy).saveChoice({ ...scope, recordId: request.recordId },
            request.generation, request.operationId, request.choice, request.submitted);
          return { ok: true, conflict, message: request.submitted ? "选择已保存在本机，待统一位置确认；冲突仍待处理。" : "整理内容已保存在本机，可稍后继续。" };
        } catch (error) {
          return { ok: false, outcome: error instanceof LocalStoreError && error.outcome === "unconfirmed" ? "unconfirmed" : "not-saved",
            message: error instanceof Error && /[\u4e00-\u9fff]/.test(error.message) ? error.message : "选择保存失败，请保留整理内容后重试。" };
        }
      }
      if (request.action === "todo-progress") {
        if (request.workspaceId !== binding.workspace.workspaceId || typeof request.recordId !== "string" || !request.recordId.trim() || request.recordId.length > 512 ||
            typeof request.operationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId) || typeof request.baseSequence !== "number" ||
            typeof request.at !== "string" || !Number.isFinite(Date.parse(request.at))) throw new Error("原任务或操作依据无效。");
        const reference = { workspaceId: binding.workspace.workspaceId, domainId: TODO_DOMAIN, recordId: request.recordId, operationId: request.operationId };
        const signature = createHash("sha256").update(canonical({ recordId: request.recordId, baseSequence: request.baseSequence, command: request.command, at: request.at })).digest("hex");
        const prior = (await store.listPending(reference)).some(op => op.operationId.startsWith("batch1~" + request.operationId + "~"));
        const content = prior ? store : await registry.contentStore(TODO_DOMAIN);
        let restoredAncestors = 0;
        const save = await new CollectionContentService(content).mutate(reference, request.baseSequence, signature, (rows) => {
          const mutations = prepareTodoTree(rows, request.recordId!, request.command as TodoCommand, request.at!);
          restoredAncestors = mutations.filter(item=>item.recordId!==request.recordId && item.value?.completed===false && rows.find(r=>r.recordId===item.recordId)?.payload?.completed===true).length;
          return mutations;
        });
        if (save.status === "saved-local") await store.clearEditor(reference).catch(() => undefined);
        let record;
        let records;
        try {
          const found = await store.readRecord(reference);
          record = found && !found.deleted ? found : null;
          records = await store.listRecords({ workspaceId: binding.workspace.workspaceId, domainId: TODO_DOMAIN });
        } catch { /* A confirmed receipt is independent from a subsequent read failure. */ }
        return { ok: true, save, ...(restoredAncestors ? {message:"已将 "+restoredAncestors+" 个受影响的父事项恢复为未完成。"} : {}), ...(record !== undefined ? { record } : {}), ...(records ? { records } : {}) };
      }
      if (request.action === "todo-detail") {
        if (typeof request.recordId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.recordId)) throw new Error("请选择有效的原任务。");
        const content = await registry.contentStore(TODO_DOMAIN);
        const found = await content.readRecord({ workspaceId: binding.workspace.workspaceId, domainId: TODO_DOMAIN, recordId: request.recordId });
        return { ok: true, record: found && !found.deleted ? found : null };
      }
      if (request.action === "todo-create" || request.action === "todo-recover") {
        if (typeof request.recordId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.recordId) ||
            typeof request.operationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId)) throw new Error("原待办操作身份无效。");
        const reference = { workspaceId: binding.workspace.workspaceId, domainId: TODO_DOMAIN, recordId: request.recordId, operationId: request.operationId };
        const content = request.action === "todo-create" ? await registry.contentStore(TODO_DOMAIN) : store;
        const service = new LocalContentService({ ...content, commit: (change) => content.commit(change, null) });
        let save;
        if (request.action === "todo-recover") {
          save = await new LocalContentService(store).recover(reference);
          if (save.status === "save-unconfirmed") {
            if (typeof request.createdAt !== "string" || !Number.isFinite(Date.parse(request.createdAt))) throw new Error("原创建信息不完整，请保留材料。");
            const scoped = await registry.contentStore(TODO_DOMAIN);
            save = await new LocalContentService({ ...scoped, commit: (change) => scoped.commit(change, null) })
              .save({ ...reference, kind: "put", payload: prepareTodo(request.text, request.createdAt) });
          }
        } else {
          const domain = await registry.get(TODO_DOMAIN);
          if (!domain.enabled || !domain.programAvailable) throw new Error("待办已停用或程序不可用，原输入保留。");
          if (typeof request.createdAt !== "string" || !Number.isFinite(Date.parse(request.createdAt))) throw new Error("创建时间无效。");
          save = await service.save({ ...reference, kind: "put", payload: prepareTodo(request.text, request.createdAt) });
        }
        let records;
        try { records = await store.listRecords({ workspaceId: binding.workspace.workspaceId, domainId: TODO_DOMAIN }); } catch { /* A known receipt remains valid even if the following list read fails. */ }
        return { ok: true, workspaceId: binding.workspace.workspaceId, save, ...(records ? { records } : {}) };
      }
      if (request.action === "read-domain" || request.action === "save-record" || request.action === "delete-record") {
        if (typeof request.domainId !== "string") throw new Error("请选择已登记领域。");
        const domain = await registry.get(request.domainId);
        if (!domain.enabled || !domain.programAvailable) throw new Error("领域已停用或本机缺少兼容程序，请返回管理目录处理；原数据保留。");
        if (request.action === "delete-record") {
          if (!domain.definition.actions.includes("delete") || typeof request.recordId !== "string" || typeof request.operationId !== "string") throw new Error("扩展不支持此删除操作。");
          const scope = { workspaceId: binding.workspace.workspaceId, domainId: request.domainId, recordId: request.recordId };
          const previous = await store.readRecord(scope);
          if (!previous || previous.deleted) throw new Error("目标内容不存在或已经删除。");
          const content = await registry.contentStore(request.domainId);
          await content.commit({ ...scope, operationId: request.operationId, kind: "delete", payloadJson: null }, previous.localSequence);
        }
        if (request.action === "save-record") {
          if (!request.payload || typeof request.recordId !== "string" || typeof request.operationId !== "string" ||
              !/^[a-zA-Z0-9_-]{1,128}$/.test(request.recordId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId)) throw new Error("无效的领域内容或操作身份。");
          const existing = await store.readRecord({ workspaceId: binding.workspace.workspaceId, domainId: request.domainId, recordId: request.recordId });
          if (existing && (typeof request.baseSequence !== "number" || request.baseSequence !== existing.localSequence)) throw new Error("原编辑依据已变化，请保留输入并核对最新进度。");
          if (existing?.deleted) throw new Error("原内容已经删除，请从冲突处理入口核对；未将旧编辑转为新增。");
          const editor = await store.editor({ workspaceId: binding.workspace.workspaceId, domainId: request.domainId, recordId: request.recordId });
          if (editor && editor.baseSequence !== existing?.localSequence) throw new Error("编辑依据已变化，原输入保留，请核对最新进度。");
          if (!domain.definition.actions.includes(existing ? "update" : "create")) throw new Error("扩展未声明此内容动作。");
          validateExtensionRecord(domain.definition, request.payload);
          const content = await registry.contentStore(request.domainId);
          const save = await new LocalContentService({ ...content, commit: (change) => content.commit(change, existing?.localSequence ?? null) })
            .save({ workspaceId: binding.workspace.workspaceId, domainId: request.domainId, recordId: request.recordId, operationId: request.operationId, kind: "put", payload: request.payload });
          if (save.status === "saved-local") await store.clearEditor({ workspaceId: binding.workspace.workspaceId, domainId: request.domainId, recordId: request.recordId }).catch(() => undefined);
          let records;
          try { records = await store.listRecords({ workspaceId: binding.workspace.workspaceId, domainId: request.domainId }); } catch { /* Preserve the confirmed receipt independently of the next read. */ }
          return { ok: true, workspaceId: binding.workspace.workspaceId, save, ...(records ? { records } : {}) };
        }
        return { ok: true, records: await store.listRecords({ workspaceId: binding.workspace.workspaceId, domainId: request.domainId }) };
      }
      let message = "";
      if (request.action === "remove-program") {
        if (typeof request.domainId !== "string") throw new Error("请选择要移除的本机领域程序。");
        await registry.removeProgram(request.domainId);
        message = "仅移除了本机程序；工作空间登记、启用状态、内容与待同步成果保留。";
      } else if (request.action === "enable" || request.action === "disable") {
        if (typeof request.domainId !== "string" || typeof request.operationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId)) throw new Error("领域或操作身份无效。");
        await registry.setEnabled(request.domainId, request.action === "enable", request.operationId);
        message = "启用状态已保存在本机，待同步；不表示所有设备已获知。";
      } else if (request.action === "register") {
        if (typeof request.source !== "string" || typeof request.operationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId)) throw new Error("扩展或原操作身份无效。");
        const result = await registry.register(parseExtension(request.source), request.operationId);
        message = result === "registered" ? "已保存在本机，待同步；可继续明确启用。" : result === "program-restored" ? "已补齐同一领域程序，原数据保留。" : "该领域已登记，无需重复创建。";
      } else if (request.action !== "list") throw new Error("当前领域动作尚未开放。");
      return { ok: true, domains: await registry.list(), message };
    } catch (error) {
      return { ok: false, message: error instanceof Error && /[\u4e00-\u9fff]/.test(error.message) ? error.message : "保存或读取结果暂不能确认，请保留输入并核对原操作；原登记和数据未被替换。" };
    } finally { if (store) await store.close().catch(() => undefined); release(); if (writeAttempt) onSaved(); }
  });
}

export async function provisionTodo(binding: WorkspaceBinding, base: string): Promise<void> {
  const store = await SqliteLocalStore.open({ databasePath: binding.replicaPath });
  try {
    const registry = new DomainRegistry(binding.workspace.workspaceId, store, new FileExtensionPrograms(join(base, "programs", binding.workspace.workspaceId)));
    await registry.register(todoDefinition, "builtin-todo-registration");
    await registry.setEnabled(TODO_DOMAIN, true, "builtin-todo-default-enable");
  } finally { await store.close(); }
}
