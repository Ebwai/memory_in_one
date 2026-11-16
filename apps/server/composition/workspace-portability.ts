import { mkdir, readFile, writeFile, rename, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { canonical, type JsonObject, type McpGrant, type WorkspaceIdentity } from "@workspace/contracts";
import { SqliteLocalStore, decodeArchive, encodeArchive, recoverArchive } from "@workspace/adapters";
import { todoDefinition, TODO_DOMAIN } from "@workspace/todo-list";

// Agent-supplied paths never reach the filesystem: all artifacts are scoped to
// this grant and stable operation ID, under the current service's data directory.
export class WorkspacePortability {
  constructor(private readonly directory: string) {}
  private root(grant: McpGrant) { return join(this.directory, "mcp-artifacts", grant.id); }
  private id(value: unknown): string {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error("请提供稳定的原调用身份（字母、数字、下划线或短横线，最多 100 字符）。");
    return value;
  }
  async status(grant: McpGrant, operationId: unknown): Promise<unknown | null> {
    if (typeof operationId !== "string") throw new Error("缺少原调用身份。");
    const id = operationId.startsWith(grant.id + ":") ? operationId.slice(grant.id.length + 1) : operationId;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return null;
    try { return JSON.parse(await readFile(join(this.root(grant), id, "receipt.json"), "utf8")).result; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async history(grants: readonly McpGrant[]): Promise<unknown[]> {
    const calls: unknown[] = [];
    for (const grant of grants) {
      let entries;
      try { entries = await readdir(this.root(grant), { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,100}$/.test(entry.name)) continue;
        try {
          const receipt = JSON.parse(await readFile(join(this.root(grant), entry.name, "receipt.json"), "utf8"));
          if (receipt.audit) calls.push(receipt.audit);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    return calls;
  }
  async execute(grant: McpGrant, identity: WorkspaceIdentity, method: string, input: JsonObject, store: SqliteLocalStore, recheck: () => Promise<unknown>): Promise<unknown> {
    const action = method === "workspace-backup" ? "backup" : method === "workspace-restore" ? "recovery" : "migration";
    if (!grant.domains.includes("*") || !grant.actions.includes(action)) throw new Error("未授予完整工作空间的" + action + "权限。");
    if (method === "workspace-migration" && input.action === "status" && !input.recoveryOperationId) return store.authorityControl(identity.workspaceId, identity.authorityId, "status");
    const id = this.id(input.operationId);
    const root = join(this.root(grant), id);
    await mkdir(root, { recursive: true });
    const key = createHash("sha256").update(canonical({ method, ...input })).digest("hex");
    try {
      const prior = JSON.parse(await readFile(join(root, "receipt.json"), "utf8"));
      if (prior.key !== key) throw new Error("原调用身份不能用于另一请求。");
      return prior.result;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const lock = join(root, "running.lock");
    try { await writeFile(lock, String(process.pid), { flag: "wx" }); }
    catch { return { status: "unconfirmed", operationId: id, message: "原请求正在执行或中断，保留原 operationId 核对，不要换身份重试。" }; }
    try {
      const requestPath = join(root, "request.json");
      try {
        const previous = JSON.parse(await readFile(requestPath, "utf8"));
        if (previous.key !== key) throw new Error("原调用身份不能用于另一请求。");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await writeFile(requestPath, JSON.stringify({ key, method }), { flag: "wx" });
      }
      await recheck();
      let result: unknown;
      if (method === "workspace-backup") {
        const backupPath = join(root, "backup.workspace.json");
        let archive: string;
        try { archive = await readFile(backupPath, "utf8"); decodeArchive(archive); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          archive = encodeArchive({ workspace: identity, location: "统一位置", snapshot: await store.snapshot(identity.workspaceId, "authority") });
          const staged = join(root, randomUUID() + ".partial");
          await writeFile(staged, archive, { flag: "wx" });
          await rename(staged, backupPath);
        }
        result = { status: "accepted", operationId: id, path: join(root, "backup.workspace.json"), archive, message: "统一位置一致备份已生成，不包含其他设备尚未同步的修改，也不包含有效接入凭据。" };
      } else if (method === "workspace-restore") {
        const text = typeof input.archive === "string" ? input.archive : await readFile(join(this.root(grant), this.id(input.backupOperationId), "backup.workspace.json"), "utf8");
        const archive = decodeArchive(text);
        if (archive.workspace.workspaceId !== identity.workspaceId || archive.workspace.authorityId !== identity.authorityId || archive.snapshot.source !== "authority") throw new Error("只能恢复当前空间的统一位置备份。");
        const target = join(root, "recovered");
        const summary = await recoverArchive(archive, target, true, { [TODO_DOMAIN]: createHash("sha256").update(JSON.stringify(todoDefinition)).digest("hex") });
        result = { status: "accepted", operationId: id, summary, message: "已恢复到服务器独立目录，原空间未覆盖；目标待迁移启用。旧凭据不会随备份恢复。" };
      } else {
        if (input.action === "stop") {
          result = await store.authorityControl(identity.workspaceId, identity.authorityId, "stop");
        } else {
          const recoveryId = this.id(input.recoveryOperationId);
          const restored = await this.status(grant, recoveryId) as { summary?: { target: string } } | null;
          if (!restored?.summary) throw new Error("请先通过 workspace_restore 完成恢复。");
          const target = join(this.root(grant), recoveryId, "recovered");
          const recovered = await SqliteLocalStore.open({ databasePath: join(target, "workspace.sqlite") });
          try {
            if (input.action === "activate") {
              const source = await store.authorityControl(identity.workspaceId, identity.authorityId, "status");
              if (source.state !== "stopped") throw new Error("请先停写原位置；当前原位置仍可写入，不能激活第二个位置。");
              await recheck();
            } else if (input.action !== "status") throw new Error("迁移动作仅支持 status、stop、activate。");
            result = { ...await recovered.authorityControl(identity.workspaceId, identity.authorityId, input.action === "activate" ? "activate" : "status"), directory: target, message: "目标数据目录已就绪。将服务的数据目录切换为此 directory 后接入；需重新创建目标接入授权，旧凭据不恢复。" };
          } finally { await recovered.close(); }
        }
      }
      const temporary = join(root, randomUUID() + ".partial");
      const audit = { workspaceId: identity.workspaceId, operationId: grant.id + ":" + id, sourceId: grant.id, sourceName: grant.name,
        domainId: "workspace", action, recordId: id, summary: method + " · " + String(input.action ?? id), time: new Date().toISOString(), confirmed: false, status: "succeeded", result: { status: "accepted", operationId: id } };
      await writeFile(temporary, JSON.stringify({ key, result, audit }), { flag: "wx", flush: true });
      await rename(temporary, join(root, "receipt.json"));
      return result;
    } finally { await unlink(lock).catch(() => {}); }
  }
}
