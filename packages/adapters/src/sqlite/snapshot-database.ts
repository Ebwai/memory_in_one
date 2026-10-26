import type { DatabaseSync } from "node:sqlite";
import type { JsonObject, WorkspaceSnapshot } from "@workspace/contracts";
import { SCHEMA_VERSION } from "./schema.js";

// Explicit allowlist: credentials, live grants, host programs and ordinary editor input
// are deliberately absent. Unknown domains remain opaque rows in these known tables.
const common = ["retained_conflicts", "mcp_requests", "mcp_calls"] as const;
const authority = ["authority_versions", "authority_receipts"] as const;
const local = ["pending_operations", "local_records", "replica_progress", "replica_cursors"] as const;

import { authorityState } from "./authority-lifecycle.js";

export function captureSnapshot(db: DatabaseSync, workspaceId: string, source: "authority" | "local"): WorkspaceSnapshot {
  if (!workspaceId.trim() || (source !== "authority" && source !== "local")) throw new Error("Invalid snapshot source");
  db.exec("BEGIN");
  try {
    // Establish the read snapshot before assigning its time. All following reads share it.
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    const capturedAt = new Date().toISOString();
    const integrity = db.prepare("PRAGMA quick_check").all();
    if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== "ok" || db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Incomplete database");
    const tables: Record<string, JsonObject[]> = {};
    for (const table of [...common, ...(source === "authority" ? authority : local)]) {
      tables[table] = db.prepare(`SELECT * FROM ${table} WHERE workspace_id=? ORDER BY rowid`).all(workspaceId) as JsonObject[];
    }
    tables.grant_definitions = db.prepare("SELECT workspace_id,id,grant_json FROM mcp_grants WHERE workspace_id=? ORDER BY rowid").all(workspaceId) as JsonObject[];
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='archive_grant_definitions'").get()) {
      const ids = new Set(tables.grant_definitions.map(row => row.id));
      tables.grant_definitions.push(...(db.prepare("SELECT workspace_id,id,grant_json FROM archive_grant_definitions WHERE workspace_id=? ORDER BY rowid").all(workspaceId) as JsonObject[]).filter(row => !ids.has(row.id)));
    }
    if (source === "local") {
      tables.operation_delivery = db.prepare("SELECT d.* FROM operation_delivery d JOIN pending_operations p ON p.sequence=d.sequence WHERE p.workspace_id=? ORDER BY d.sequence").all(workspaceId) as JsonObject[];
      if (tables.operation_delivery.length !== tables.pending_operations!.length) throw new Error("Missing operation continuation");
      const sequences = new Set(tables.pending_operations!.map(row => row.sequence));
      if (tables.local_records!.some(row => !sequences.has(row.last_sequence)) || tables.operation_delivery.some(row => row.parent_sequence !== null && !sequences.has(row.parent_sequence))) throw new Error("Broken local relationships");
    }
    // Parsing every JSON column detects unreadable material without dropping any row.
    for (const rows of Object.values(tables)) for (const row of rows) for (const [key, value] of Object.entries(row)) {
      if (key.endsWith("_json") && value !== null) JSON.parse(String(value));
    }
    const revisionFloor = source === "authority" ? Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name=\'authority_versions\'").get()?.seq ?? 0) : Number(db.prepare("SELECT cursor FROM replica_cursors WHERE workspace_id=?").get(workspaceId)?.cursor ?? 0);
    const result: WorkspaceSnapshot = { format: "workspace-snapshot", version: 1, schemaVersion: SCHEMA_VERSION, workspaceId, source, revisionFloor, authorityState: authorityState(db), capturedAt, tables };
    db.exec("COMMIT");
    return result;
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
}
