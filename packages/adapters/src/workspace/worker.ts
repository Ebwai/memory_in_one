import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { APPLICATION_ID, CREATE_SCHEMA, SCHEMA_VERSION } from "../sqlite/schema.js";
import type { WorkspaceCreateResult, WorkspaceIdentity, WorkspaceProposal } from "@workspace/contracts";

const request = workerData as { directory: string; method: "create" | "inspect"; proposal?: WorkspaceProposal };
const directory = resolve(request.directory);
const destination = join(directory, "workspace.sqlite");

function inspect(path: string): WorkspaceIdentity | null {
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    if (db.prepare("PRAGMA application_id").get()?.application_id !== APPLICATION_ID ||
      ![1, 2, 3, SCHEMA_VERSION].includes(Number(db.prepare("PRAGMA user_version").get()?.user_version))) throw new Error("Unrecognized database");
    const row = db.prepare("SELECT workspace_id, authority_id, name, creation_id, created_at FROM workspace_identity WHERE singleton = 1").get();
    if (!row) throw new Error("Incomplete workspace");
    return { workspaceId: String(row.workspace_id), authorityId: String(row.authority_id), name: String(row.name),
      creationId: String(row.creation_id), createdAt: String(row.created_at) };
  } finally { db.close(); }
}

function existingResult(existing: WorkspaceIdentity, proposal: WorkspaceProposal): WorkspaceCreateResult {
  if (existing.creationId !== proposal.creationId) return { status: "rejected", reason: "target-occupied",
    message: "该位置已有工作空间，请使用已有空间接入，或选择其他位置；恢复备份请使用恢复入口。" };
  if (existing.name !== proposal.name) return { status: "rejected", reason: "request-mismatch", message: "原创建请求的名称不同，请核对原请求。" };
  return { status: "created", workspace: existing };
}

function create(proposal: WorkspaceProposal): WorkspaceCreateResult {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(proposal.creationId)) throw new Error("Invalid creation identity");
  if (existsSync(destination)) {
    try { return existingResult(inspect(destination)!, proposal); }
    catch { return { status: "rejected", reason: "target-occupied", message: "目标文件已有数据或无法识别，未覆盖；请选择已有空间接入或其他位置。" }; }
  }
  mkdirSync(directory, { recursive: true });
  const staging = join(directory, ".initialize-" + proposal.creationId + ".sqlite");
  if (!existsSync(staging)) {
    let descriptor: number;
    try { descriptor = openSync(staging, "wx", 0o600); }
    catch { return { status: "unconfirmed", message: "原创建请求正在处理，请稍后核对。" }; }
    closeSync(descriptor);
    const db = new DatabaseSync(staging);
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
      db.exec(CREATE_SCHEMA);
      db.exec(`CREATE TABLE workspace_identity (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), workspace_id TEXT NOT NULL UNIQUE,
        authority_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL CHECK(length(trim(name)) > 0),
        creation_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL) STRICT;`);
      db.prepare("INSERT INTO workspace_identity VALUES (1, ?, ?, ?, ?, ?)").run(
        proposal.workspaceId, proposal.authorityId, proposal.name, proposal.creationId, proposal.createdAt);
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
    } finally { db.close(); }
  }
  let staged: WorkspaceIdentity;
  try { const found = inspect(staging); if (!found) throw new Error("Staging already published"); staged = found; }
  catch {
    try { const published = inspect(destination); if (published) return existingResult(published, proposal); } catch { /* Keep uncertain materials. */ }
    return { status: "unconfirmed", message: "原创建材料尚不能确认，请保留原请求与位置后再次核对。" };
  }
  const checked = existingResult(staged, proposal);
  if (checked.status !== "created") return checked;
  // Windows requires a write-capable handle when flushing the complete staging file.
  try {
    const descriptor = openSync(staging, "r+");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  } catch {
    try { const published = inspect(destination); if (published) return existingResult(published, proposal); } catch { /* Another publisher may still be finishing. */ }
    return { status: "unconfirmed", message: "原创建发布结果尚不能确认，请按原请求核对。" };
  }
  try { linkSync(staging, destination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try { return existingResult(inspect(destination)!, proposal); } catch { /* Preserve the occupied target. */ }
    }
    return { status: "unconfirmed", message: "尚不能确认空间已发布，请保留原位置和请求再核对。" };
  }
  // Remove only this complete staging link. The published database remains intact.
  try { unlinkSync(staging); } catch { /* A spare link is harmless; never undo publication. */ }
  return { status: "created", workspace: staged };
}
try {
  const value = request.method === "inspect" ? inspect(destination) : create(request.proposal!);
  parentPort?.postMessage({ ok: true, value });
} catch { parentPort?.postMessage({ ok: false, value: null }); }
parentPort?.close();

