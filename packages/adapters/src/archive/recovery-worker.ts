import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { APPLICATION_ID, CREATE_SCHEMA, SCHEMA_VERSION } from "../sqlite/schema.js";
import { captureSnapshot } from "../sqlite/snapshot-database.js";
import { decodeArchive, encodeArchive, type WorkspaceArchive } from "./workspace-archive.js";

const request = workerData as { method: "preview" | "restore"; archive: WorkspaceArchive; target: string; programFingerprints: Readonly<Record<string, string>> };
const archive = decodeArchive(encodeArchive(request.archive));
const fingerprint = createHash("sha256").update(encodeArchive(archive)).digest("hex");
const target = resolve(request.target);
const filename = archive.snapshot.source === "local" ? "replica.sqlite" : "workspace.sqlite";
const destination = join(target, filename);
const staging = join(target, ".restore-" + fingerprint + ".sqlite");

function programAvailable(id: string): boolean {
  const rows = archive.snapshot.source === "local" ? archive.snapshot.tables.local_records : archive.snapshot.tables.authority_versions;
  const row = rows?.filter(row => row.domain_id === "system.domains" && row.record_id === id).at(-1);
  if (!row) return false;
  const registration = JSON.parse(String(row.payload_json ?? row.value_json ?? "null")) as { definition?: unknown; fingerprint?: string } | null;
  return !!registration?.definition && typeof registration.fingerprint === "string" && request.programFingerprints[id] === registration.fingerprint
    && createHash("sha256").update(JSON.stringify(registration.definition)).digest("hex") === registration.fingerprint;
}

function fill(db: DatabaseSync): void {
  const snapshot = archive.snapshot;
  if (!Number.isSafeInteger(snapshot.revisionFloor) || snapshot.revisionFloor < 0) throw new Error("统一进度边界无效。");
  if (snapshot.schemaVersion !== SCHEMA_VERSION) throw new Error("核心存储版本不兼容。");
  const names = snapshot.source === "local"
    ? ["pending_operations", "local_records", "replica_progress", "replica_cursors", "operation_delivery", "retained_conflicts", "mcp_requests", "mcp_calls"]
    : ["authority_versions", "authority_receipts", "retained_conflicts", "mcp_requests", "mcp_calls"];
  names.push("grant_definitions");
  if (Object.keys(snapshot.tables).length !== names.length || Object.keys(snapshot.tables).some(name => !names.includes(name))) throw new Error("核心材料缺失或存在不支持的数据表。");
  db.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
  try {
    db.exec(CREATE_SCHEMA);
    db.exec("CREATE TABLE archive_grant_definitions (workspace_id TEXT NOT NULL,id TEXT NOT NULL,grant_json TEXT NOT NULL CHECK(json_valid(grant_json)),PRIMARY KEY(workspace_id,id)) STRICT");
    for (const name of names) {
      const rows = snapshot.tables[name];
      if (!Array.isArray(rows)) throw new Error("核心材料缺失。");
      const table = name === "grant_definitions" ? "archive_grant_definitions" : name;
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name));
      const insert = db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
      for (const row of rows) {
        if (!row || typeof row !== "object" || Object.keys(row).length !== columns.length || columns.some(column => !Object.hasOwn(row, column))) throw new Error("数据字段不兼容。");
        if (name !== "operation_delivery" && row.workspace_id !== snapshot.workspaceId) throw new Error("材料混入不同空间。");
        for (const [key, value] of Object.entries(row)) {
          if (value !== null && typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) throw new Error("数据值无法完整保留。");
          if (key.endsWith("_json") && value !== null) {
            const material = JSON.parse(String(value)) as Record<string, unknown> | null;
            if (material && !Array.isArray(material) && !["payload_json", "value_json", "before_json"].includes(key)) {
              if (material.workspaceId !== undefined && material.workspaceId !== snapshot.workspaceId) throw new Error("接续材料空间不匹配。");
              if (material.authorityId !== undefined && material.authorityId !== archive.workspace.authorityId) throw new Error("接续材料权威身份不匹配。");
              for (const [column, property] of [["domain_id", "domainId"], ["record_id", "recordId"], ["operation_id", "operationId"]] as const) {
                if (row[column] !== undefined && material[property] !== undefined && row[column] !== material[property]) throw new Error("接续材料归属不匹配。");
              }
            }
          }
        }
        insert.run(...columns.map(column => row[column] as string | number | null));
      }
    }
    if (snapshot.source === "local") {
      if (db.prepare("SELECT 1 FROM pending_operations p LEFT JOIN operation_delivery d ON p.sequence=d.sequence WHERE d.sequence IS NULL LIMIT 1").get()) throw new Error("缺少操作发送状态。");
      if (db.prepare("SELECT 1 FROM local_records r JOIN pending_operations p ON p.sequence=r.last_sequence WHERE r.workspace_id!=p.workspace_id OR r.domain_id!=p.domain_id OR r.record_id!=p.record_id OR r.deleted!=(p.kind='delete') OR r.payload_json IS NOT p.payload_json LIMIT 1").get()) throw new Error("当前内容和原操作不对应。");
      if (db.prepare("SELECT 1 FROM operation_delivery d LEFT JOIN pending_operations parent ON parent.sequence=d.parent_sequence JOIN pending_operations p ON p.sequence=d.sequence WHERE d.parent_sequence IS NOT NULL AND (parent.sequence IS NULL OR parent.sequence>=p.sequence OR parent.workspace_id!=p.workspace_id OR parent.domain_id!=p.domain_id OR parent.record_id!=p.record_id) LIMIT 1").get()) throw new Error("操作接续关系损坏。");
      for (const row of db.prepare("SELECT p.*, d.request_json FROM pending_operations p JOIN operation_delivery d ON d.sequence=p.sequence WHERE d.request_json IS NOT NULL").all()) {
        const frozen = JSON.parse(String(row.request_json)) as Record<string, unknown>;
        if (frozen.workspaceId !== row.workspace_id || frozen.authorityId !== archive.workspace.authorityId || frozen.domainId !== row.domain_id || frozen.recordId !== row.record_id || frozen.operationId !== row.operation_id) throw new Error("冻结操作身份不匹配。");
      }
    }
    // Program availability is a new host fact, never copied from the source.
    const domainRows = snapshot.source === "local" ? snapshot.tables.local_records! : snapshot.tables.authority_versions!;
    const domainIds = new Set(domainRows.map(row => row.domain_id === "system.domains" ? String(row.record_id) : String(row.domain_id)));
    for (const id of domainIds) db.prepare("INSERT INTO mcp_host_programs VALUES(?,?,?)").run(snapshot.workspaceId, id, programAvailable(id) ? 1 : 0);
    // A restored authority is prepared, never implicitly writable. Local replicas
    // have no authority identity and cannot be mistaken for a new authority.
    db.exec("CREATE TABLE authority_lifecycle (singleton INTEGER PRIMARY KEY CHECK(singleton=1), state TEXT NOT NULL CHECK(state IN ('active','stopped','prepared'))) STRICT; INSERT INTO authority_lifecycle VALUES(1,'prepared')");
    db.exec("CREATE TABLE workspace_restore (singleton INTEGER PRIMARY KEY CHECK(singleton=1), fingerprint TEXT NOT NULL, archive_json TEXT NOT NULL) STRICT");
    db.prepare("INSERT INTO workspace_restore VALUES(1,?,?)").run(fingerprint, JSON.stringify({ workspace: archive.workspace, source: snapshot.source, capturedAt: snapshot.capturedAt, location: archive.location, authorityState: snapshot.authorityState }));
    if (snapshot.source === "authority") {
      db.exec("CREATE TABLE workspace_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1),workspace_id TEXT NOT NULL UNIQUE,authority_id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,creation_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL) STRICT");
      const w = archive.workspace;
      db.prepare("INSERT INTO workspace_identity VALUES(1,?,?,?,?,?)").run(w.workspaceId, w.authorityId, w.name, w.creationId, w.createdAt);
    }
    if (snapshot.source === "authority") {
      const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='authority_versions'").get();
      if (sequence) db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='authority_versions'").run(snapshot.revisionFloor);
      else db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('authority_versions',?)").run(snapshot.revisionFloor);
    }
    db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}`);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("恢复关系校验失败。");
    db.exec("COMMIT");
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
}

function summary() {
  const s = archive.snapshot, tables = s.tables;
  const rows = s.source === "local" ? tables.local_records! : tables.authority_versions!;
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) latest.set(String(row.domain_id) + "/" + String(row.record_id), row);
  const domains = new Map<string, { domainId: string; name: string; available: boolean }>();
  for (const row of latest.values()) {
    const id = row.domain_id === "system.domains" ? String(row.record_id) : String(row.domain_id);
    let name = id;
    if (row.domain_id === "system.domains") {
      const value = JSON.parse(String(row.payload_json ?? row.value_json ?? "null")) as { definition?: { name?: string } } | null;
      name = value?.definition?.name ?? id;
    }
    const previous = domains.get(id);
    domains.set(id, { domainId: id, name: previous?.name ?? name, available: programAvailable(id) });
  }
  return { workspace: archive.workspace, source: s.source, capturedAt: s.capturedAt, location: archive.location, target, databasePath: destination,
    domains: [...domains.values()], pending: (tables.operation_delivery ?? []).filter(row => row.state === "pending").length,
    uncertain: (tables.operation_delivery ?? []).filter(row => row.state === "pending" && row.uncertain === 1).length,
    conflicts: tables.retained_conflicts!.filter(row => row.status === "pending").length,
    fingerprint, state: s.source === "authority" ? "prepared" as const : "local" as const };
}

function matches(path: string): boolean {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (db.prepare("SELECT fingerprint FROM workspace_restore WHERE singleton=1").get()?.fingerprint !== fingerprint) return false;
    // Re-read the complete result, not only its receipt, before reporting success.
    const reread = captureSnapshot(db, archive.snapshot.workspaceId, archive.snapshot.source);
    const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
    return canonical(reread.tables) === canonical(archive.snapshot.tables);
  } finally { db.close(); }
}

function run() {
  if (!request.target || target === resolve("/")) throw new Error("请选择空白恢复目标。");
  const validation = new DatabaseSync(":memory:");
  try { fill(validation); } finally { validation.close(); }
  if (existsSync(destination)) {
    if (request.method === "restore" && matches(destination)) return { ...summary(), alreadyRestored: true };
    throw new Error("目标已有数据，未覆盖或合并。");
  }
  if (existsSync(target) && readdirSync(target).some(name => name !== ".restore-" + fingerprint + ".sqlite" && name !== ".restore-" + fingerprint + ".sqlite-journal")) throw new Error("目标非空，请选择空白目录。");
  if (request.method === "preview") return summary();
  mkdirSync(target, { recursive: true });
  if (!existsSync(staging)) {
    const fd = openSync(staging, "wx", 0o600); closeSync(fd);
    const db = new DatabaseSync(staging);
    try { fill(db); } finally { db.close(); }
  }
  // A crash inside fill rolls back the entire transaction. Reuse only an empty
  // staging database belonging to this exact fingerprint; never clear partial or
  // unrelated committed data. SQLite recovers its own interrupted journal.
  const resumed = new DatabaseSync(staging);
  try {
    resumed.exec("PRAGMA busy_timeout=5000; BEGIN EXCLUSIVE");
    const empty = resumed.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get() === undefined;
    resumed.exec("COMMIT");
    if (empty) fill(resumed);
  } finally { resumed.close(); }
  if (!matches(staging)) throw new Error("原恢复材料尚未完整，请保留目标核对，未发布半成品。");
  const fd = openSync(staging, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); }
  if (readdirSync(target).some(name => name !== ".restore-" + fingerprint + ".sqlite")) throw new Error("目标在校验后被占用，已停止恢复。");
  try { linkSync(staging, destination); }
  catch (error) { if (!existsSync(destination) || !matches(destination)) throw error; }
  try { unlinkSync(staging); } catch { /* Published result owns the durable recovery receipt. */ }
  return { ...summary(), alreadyRestored: false };
}

try { parentPort!.postMessage({ ok: true, value: run() }); }
catch (error) { parentPort!.postMessage({ ok: false, message: error instanceof Error ? error.message : "恢复无法完成。" }); }
