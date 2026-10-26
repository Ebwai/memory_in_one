import { McpDatabase } from "./mcp-database.js";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { canonical, LocalStoreError } from "@workspace/contracts";
import type { AuthorityVersion, ContentValue, Delivery, LocalRecord, PreparedChange, RecordScope, ReplicationCommand, RetainedConflict, UploadRequest, UploadResult } from "@workspace/contracts";
import type { LocalDatabase } from "./database.js";

import { captureSnapshot } from "./snapshot-database.js";

import { authorityState, requireAuthorityWrite } from "./authority-lifecycle.js";

export class ReplicationDatabase {
  constructor(private readonly db: DatabaseSync, private readonly local: LocalDatabase) {}
  private transaction<T>(work: () => T, readOnly = false): T {
    if (this.db.isTransaction) return work();
    this.db.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (cause) {
      if (!this.db.isTransaction) throw new LocalStoreError("unconfirmed", { cause });
      try { this.db.exec("ROLLBACK"); } catch { throw new LocalStoreError("unconfirmed", { cause }); }
      throw cause instanceof LocalStoreError ? cause : new LocalStoreError("not-saved", { cause });
    }
  }
  private args(scope: RecordScope): [string, string, string] { return [scope.workspaceId, scope.domainId, scope.recordId]; }
  private current(scope: RecordScope, revision?: number): AuthorityVersion | null {
    const row = revision === undefined
      ? this.db.prepare("SELECT * FROM authority_versions WHERE workspace_id=? AND domain_id=? AND record_id=? ORDER BY revision DESC LIMIT 1").get(...this.args(scope))
      : this.db.prepare("SELECT * FROM authority_versions WHERE workspace_id=? AND domain_id=? AND record_id=? AND revision=?").get(...this.args(scope), revision);
    return row ? { workspaceId: scope.workspaceId, domainId: scope.domainId, recordId: scope.recordId,
      revision: Number(row.revision), value: JSON.parse(String(row.value_json)) as ContentValue, changed: JSON.parse(String(row.changed_json)) as string[] } : null;
  }
  private confirmed(scope: RecordScope): AuthorityVersion | null {
    const row = this.db.prepare("SELECT version_json FROM replica_progress WHERE workspace_id=? AND domain_id=? AND record_id=?").get(...this.args(scope));
    return row ? JSON.parse(String(row.version_json)) as AuthorityVersion : null;
  }
  private saveConfirmed(version: AuthorityVersion): void {
    const prior = this.confirmed(version);
    if (prior && prior.revision > version.revision) return;
    if (prior?.revision === version.revision && canonical(prior.value) !== canonical(version.value)) throw new LocalStoreError("operation-mismatch");
    this.db.prepare(`INSERT INTO replica_progress VALUES(?,?,?,?) ON CONFLICT(workspace_id,domain_id,record_id) DO UPDATE SET version_json=excluded.version_json`)
      .run(...this.args(version), JSON.stringify(version));
  }
  track(change: PreparedChange, sequence: number, before: LocalRecord | null): void {
    this.db.prepare("INSERT INTO operation_delivery(sequence,base_json,before_json,parent_sequence,state) VALUES(?,?,?,?,'pending')")
      .run(sequence, JSON.stringify(this.confirmed(change)), JSON.stringify(before?.deleted ? null : before?.payload ?? null), before?.localSequence ?? null);
  }
  resolved(conflict: RetainedConflict, sequence: number): void {
    const accepted = conflict.comparison.remote;
    if (!accepted) throw new LocalStoreError("operation-mismatch");
    const version: AuthorityVersion = { workspaceId: conflict.workspaceId, domainId: conflict.domainId, recordId: conflict.recordId, ...accepted, changed: [] };
    this.db.prepare(`UPDATE operation_delivery SET state='superseded' WHERE sequence IN
      (SELECT sequence FROM pending_operations WHERE workspace_id=? AND domain_id=? AND record_id=?) AND state='pending'`).run(...this.args(conflict));
    this.db.prepare("INSERT INTO operation_delivery(sequence,base_json,before_json,state,result_json) VALUES(?,'null','null','acked',?)")
      .run(sequence, JSON.stringify(version));
    this.saveConfirmed(version);
    this.db.prepare("DELETE FROM editor_drafts WHERE workspace_id=? AND domain_id=? AND record_id=?").run(...this.args(conflict));
  }
  private imported(version: AuthorityVersion): void {
    const row = this.db.prepare("INSERT INTO pending_operations(workspace_id,domain_id,record_id,operation_id,kind,payload_json) VALUES(?,?,?,?,?,?)")
      .run(...this.args(version), "@remote/" + randomUUID(), version.value === null ? "delete" : "put", version.value === null ? null : JSON.stringify(version.value));
    const sequence = Number(row.lastInsertRowid);
    this.db.prepare("INSERT INTO operation_delivery(sequence,base_json,before_json,state,result_json) VALUES(?,'null','null','imported',?)").run(sequence, JSON.stringify(version));
    this.db.prepare(`INSERT INTO local_records VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,domain_id,record_id) DO UPDATE SET
      deleted=excluded.deleted,payload_json=excluded.payload_json,last_sequence=excluded.last_sequence`)
      .run(...this.args(version), version.value === null ? 1 : 0, version.value === null ? null : JSON.stringify(version.value), sequence);
  }
  private receipt(request: UploadRequest): UploadResult | null {
    const row = this.db.prepare("SELECT request_json,result_json FROM authority_receipts WHERE workspace_id=? AND operation_id=?").get(request.workspaceId, request.operationId);
    if (!row) return null;
    if (String(row.request_json) !== canonical(request)) throw new LocalStoreError("operation-mismatch");
    return JSON.parse(String(row.result_json)) as UploadResult;
  }
private inventory(workspaceId: string, source: "authority" | "local"): unknown {
    return this.transaction(() => {
      const records = source === "authority"
        ? this.db.prepare("SELECT v.domain_id,v.record_id,v.value_json FROM authority_versions v WHERE workspace_id=? AND revision=(SELECT MAX(x.revision) FROM authority_versions x WHERE x.workspace_id=v.workspace_id AND x.domain_id=v.domain_id AND x.record_id=v.record_id)").all(workspaceId)
        : this.db.prepare("SELECT domain_id,record_id,CASE WHEN deleted=1 THEN 'null' ELSE payload_json END AS value_json FROM local_records WHERE workspace_id=?").all(workspaceId);
      const entries = new Map<string, { domainId: string; registration: import("@workspace/contracts").JsonObject | null; records: number; deletions: number }>();
      const entry = (id: string) => { let value = entries.get(id); if (!value) { value = { domainId: id, registration: null, records: 0, deletions: 0 }; entries.set(id, value); } return value; };
      for (const row of records) {
        const domainId = String(row.domain_id);
        const value = JSON.parse(String(row.value_json)) as import("@workspace/contracts").JsonObject | null;
        if (domainId === "system.domains") { if (value) entry(String(row.record_id)).registration = value; }
        else { const target = entry(domainId); if (value === null) target.deletions++; else target.records++; }
      }
      const count = (sql: string) => Number(this.db.prepare(sql).get(workspaceId)?.n ?? 0);
      if (source === "local") {
        for (const row of this.db.prepare("SELECT DISTINCT domain_id FROM replica_progress WHERE workspace_id=? AND domain_id!='system.domains'").all(workspaceId)) entry(String(row.domain_id));
      }
      return { domains: [...entries.values()].sort((a, b) => a.domainId.localeCompare(b.domainId)),
        pending: source === "local" ? count("SELECT count(*) AS n FROM operation_delivery d JOIN pending_operations p ON p.sequence=d.sequence WHERE p.workspace_id=? AND d.state='pending'") : 0,
        uncertain: source === "local" ? count("SELECT count(*) AS n FROM operation_delivery d JOIN pending_operations p ON p.sequence=d.sequence WHERE p.workspace_id=? AND d.state='pending' AND d.uncertain=1") : 0,
        conflicts: count("SELECT count(*) AS n FROM retained_conflicts WHERE workspace_id=? AND status='pending'"),
        savedEditing: count("SELECT count(*) AS n FROM retained_conflicts WHERE workspace_id=? AND (json_type(material_json,\'$.editorValue\')=\'object\' OR json_type(material_json,\'$.draft\')=\'object\')"),
        calls: count("SELECT count(*) AS n FROM mcp_calls WHERE workspace_id=?") };
    }, true);
  }

  execute(command: ReplicationCommand): unknown {
    switch (command.method) {
      case "local-batch": return this.transaction(() => {
        const first = command.changes[0];
        if (!first || new Set(command.changes.map(c => c.recordId)).size !== command.changes.length ||
            command.changes.some(c => c.workspaceId !== first.workspaceId || c.domainId !== first.domainId)) throw new LocalStoreError("operation-mismatch");
        const prior = command.changes.map(c => this.local.readOperation(c));
        if (prior.every(Boolean)) return command.changes.map(c => this.local.commit(c));
        if (prior.some(Boolean)) throw new LocalStoreError("operation-mismatch");
        const actual = this.local.listRecords(first);
        const versions = (rows: readonly LocalRecord[]) => canonical(rows.map(r => [r.recordId, r.localSequence]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))));
        if (versions(actual) !== versions(command.basis)) throw new LocalStoreError("operation-mismatch");
        if (actual.some(r => r.pendingConfirmation || this.local.readConflict(r)?.status === "pending")) throw new LocalStoreError("operation-mismatch");
        return command.changes.map(c => this.local.commit(c, command.basis.find(r => r.recordId === c.recordId)?.localSequence ?? null, command.guard));
      });
      case "authority-batch": return this.transaction(() => {
        requireAuthorityWrite(this.db);
        const prior = this.receipt(command.request); if (prior) return prior;
        const current = this.execute({ method: "authority-list", workspaceId: command.request.workspaceId, domainId: command.request.domainId }) as AuthorityVersion[];
        const basis = (rows: readonly AuthorityVersion[]) => canonical(rows.map(r => [r.recordId,r.revision]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))));
        if (basis(current) !== basis(command.basis) || command.guards.some(g => this.current(g)?.revision !== g.revision)) return null;
        if (command.request.audit) {
          const mcp = new McpDatabase(this.db); mcp.assertAllowed(command.request.audit);
          if (command.request.audit.action === "delete" && mcp.prepared(command.request.workspaceId, command.request.operationId)?.confirmation !== "accepted") throw new LocalStoreError("operation-mismatch");
        }
        const versions: AuthorityVersion[] = [];
        // Insert the primary last: its revision is the atomic group's feed cursor.
        const ordered = [...command.values.slice(1), command.values[0]!];
        for (const value of ordered) {
          const insert = this.db.prepare("INSERT INTO authority_versions(workspace_id,domain_id,record_id,value_json,changed_json) VALUES(?,?,?,?,?)")
            .run(...this.args(value), JSON.stringify(value.value), JSON.stringify(value.changed));
          versions.push({ workspaceId: value.workspaceId, domainId: value.domainId, recordId: value.recordId, revision: Number(insert.lastInsertRowid), value: value.value, changed: value.changed });
        }
        const primary = versions.pop()!;
        const result: UploadResult = { status: "accepted", version: { ...primary, related: versions } };
        if (command.request.audit) new McpDatabase(this.db).save({ ...command.request.audit, status: "succeeded", result: JSON.parse(JSON.stringify(result)) });
        this.db.prepare("INSERT INTO authority_receipts VALUES(?,?,?,?)").run(command.request.workspaceId,command.request.operationId,canonical(command.request),JSON.stringify(result));
        return result;
      });
      case "resolve-batch": return this.transaction(() => {
        const conflict=this.local.readConflict(command.conflict);
        if(conflict?.status==="resolved" && conflict.draft?.operationId===command.conflict.draft?.operationId)return;
        if(!conflict || conflict.generation!==command.conflict.generation || !conflict.atomicGroup || !conflict.draft?.submitted)throw new LocalStoreError("operation-mismatch");
        if(command.basis.some(r=>this.local.readRecord(r)?.localSequence!==r.localSequence || (r.recordId!==conflict.recordId && this.db.prepare("SELECT 1 FROM editor_drafts WHERE workspace_id=? AND domain_id=? AND record_id=?").get(...this.args(r)))))throw new LocalStoreError("operation-mismatch");
        for(const sequence of conflict.atomicGroup.sequences) this.db.prepare("UPDATE operation_delivery SET state='superseded',message='' WHERE sequence=? AND state='pending'").run(sequence);
        for(const version of command.versions) {
          this.imported(version);this.saveConfirmed(version);
          this.db.prepare("DELETE FROM editor_drafts WHERE workspace_id=? AND domain_id=? AND record_id=?").run(...this.args(version));
        }
        const resolved={...conflict,status:"resolved",generation:conflict.generation+1};
        this.db.prepare("UPDATE retained_conflicts SET generation=?,status='resolved',material_json=? WHERE workspace_id=? AND domain_id=? AND record_id=?").run(resolved.generation,JSON.stringify(resolved),...this.args(conflict));
      });
      case "import-batch": return this.transaction(() => {
        for (const entry of command.entries) this.execute({ method: "import", ...entry, cursor: command.cursor });
      });
      case "authority-control": return this.transaction(() => {
        const identity = this.db.prepare("SELECT workspace_id,authority_id FROM workspace_identity WHERE singleton=1").get();
        if (identity?.workspace_id !== command.workspaceId || identity.authority_id !== command.authorityId) throw new Error("迁移空间身份不匹配。");
        const state = authorityState(this.db);
        if (command.action === "status") return { state, workspaceId: command.workspaceId, authorityId: command.authorityId };
        if (command.action === "stop") {
          if (state === "prepared") throw new Error("目标尚未启用，不能冒充已停写来源。");
          this.db.exec("CREATE TABLE IF NOT EXISTS authority_lifecycle (singleton INTEGER PRIMARY KEY CHECK(singleton=1),state TEXT NOT NULL CHECK(state IN ('active','stopped','prepared'))) STRICT");
          this.db.exec("INSERT INTO authority_lifecycle VALUES(1,'stopped') ON CONFLICT(singleton) DO UPDATE SET state='stopped'");
        } else {
          if (state === "stopped") throw new Error("原位置维持停写，不能作为新目标重新启用。");
          if (state === "active") return { state, workspaceId: command.workspaceId, authorityId: command.authorityId };
          const row = this.db.prepare("SELECT archive_json FROM workspace_restore WHERE singleton=1").get();
          const material = row ? JSON.parse(String(row.archive_json)) as { source: string; authorityState: string } : null;
          if (!material || (material.authorityState !== "stopped" && command.isolated !== true)) throw new Error("需要停写后取得的材料，或明确确认原位置已停用隔离及材料覆盖边界。");
          this.db.exec("UPDATE authority_lifecycle SET state='active' WHERE singleton=1");
        }
        return { state: authorityState(this.db), workspaceId: command.workspaceId, authorityId: command.authorityId };
      });
      case "snapshot": return captureSnapshot(this.db, command.workspaceId, command.source);
      case "export-inventory": return this.inventory(command.workspaceId, command.source);
      case "mcp": return new McpDatabase(this.db).execute(command.command);
      case "authority-list": return this.db.prepare("SELECT v.* FROM authority_versions v WHERE workspace_id=? AND domain_id=? AND revision=(SELECT MAX(x.revision) FROM authority_versions x WHERE x.workspace_id=v.workspace_id AND x.domain_id=v.domain_id AND x.record_id=v.record_id) ORDER BY record_id")
        .all(command.workspaceId, command.domainId).map(row => ({ workspaceId: String(row.workspace_id), domainId: String(row.domain_id), recordId: String(row.record_id), revision: Number(row.revision), value: JSON.parse(String(row.value_json)), changed: JSON.parse(String(row.changed_json)) }));
      case "authority-read": return this.current(command.scope, command.revision);
      case "authority-changes": return [...new Set(this.db.prepare("SELECT changed_json FROM authority_versions WHERE workspace_id=? AND domain_id=? AND record_id=? AND revision>?")
        .all(...this.args(command.scope), command.after).flatMap((row) => JSON.parse(String(row.changed_json)) as string[]))];
      case "authority-receipt": return this.receipt(command.request);
      case "authority-commit": return this.transaction(() => {
        requireAuthorityWrite(this.db);
        const prior = this.receipt(command.request); if (prior) return prior;
        if (command.request.audit) new McpDatabase(this.db).assertAllowed(command.request.audit);
        const current = this.current(command.request);
        if (command.request.audit?.action === "delete") {
          const prepared = new McpDatabase(this.db).prepared(command.request.workspaceId, command.request.operationId);
          if (prepared?.confirmation !== "accepted" || current?.revision !== command.request.baseRevision) throw new LocalStoreError("operation-mismatch");
        }
        if ((current?.revision ?? 0) !== command.expectedRevision || command.guards.some((guard) => this.current(guard)?.revision !== guard.revision)) return null;
        const insert = this.db.prepare("INSERT INTO authority_versions(workspace_id,domain_id,record_id,value_json,changed_json) VALUES(?,?,?,?,?)")
          .run(...this.args(command.request), JSON.stringify(command.value), JSON.stringify(command.changed));
        const result: UploadResult = { status: "accepted", version: { workspaceId: command.request.workspaceId, domainId: command.request.domainId,
          recordId: command.request.recordId, revision: Number(insert.lastInsertRowid), value: command.value, changed: command.changed } };
        if (command.request.audit) new McpDatabase(this.db).save({ ...command.request.audit, status: "succeeded", result: JSON.parse(JSON.stringify(result)) });
        this.db.prepare("INSERT INTO authority_receipts VALUES(?,?,?,?)").run(command.request.workspaceId, command.request.operationId, canonical(command.request), JSON.stringify(result));
        return result;
      });
      case "authority-pull": {
        const latest = Math.max(Number(this.db.prepare("SELECT COALESCE(MAX(revision),0) AS revision FROM authority_versions WHERE workspace_id=?").get(command.workspaceId)?.revision ?? 0), Number(this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name=\'authority_versions\'").get()?.seq ?? 0));
        if (command.cursor > latest) throw new LocalStoreError("operation-mismatch");
        const versions: AuthorityVersion[] = [];
        let bytes = 0;
        const groups = new Map<number, AuthorityVersion>();
        for (const row of this.db.prepare("SELECT result_json FROM authority_receipts WHERE workspace_id=?").all(command.workspaceId)) {
          const receipt = JSON.parse(String(row.result_json)) as UploadResult;
          if (receipt.status === "accepted" && receipt.version.related?.length) {
            for (const member of [receipt.version,...receipt.version.related]) groups.set(member.revision,receipt.version);
          }
        }
        let consumed = command.cursor;
        for (const row of this.db.prepare("SELECT * FROM authority_versions WHERE workspace_id=? AND revision>? ORDER BY revision").iterate(command.workspaceId, command.cursor)) {
          if (Number(row.revision) <= consumed) continue;
          const group = groups.get(Number(row.revision));
          if (group) {
            if (versions.length >= 100) break;
            versions.push(group); consumed = group.revision; bytes += JSON.stringify(group).length * 2; continue;
          }
          const size = String(row.value_json).length * 2;
          if (versions.length && (versions.length >= 100 || bytes + size > 8 * 1024 * 1024)) break;
          versions.push({ workspaceId: String(row.workspace_id), domainId: String(row.domain_id), recordId: String(row.record_id),
            revision: Number(row.revision), value: JSON.parse(String(row.value_json)) as ContentValue, changed: JSON.parse(String(row.changed_json)) as string[] });
          bytes += size;
        }
        const cursor = versions.at(-1)?.revision ?? latest;
        return { versions, cursor, more: cursor < latest };
      }
      case "confirmed": return this.confirmed(command.scope);
      case "recover-frozen": this.db.prepare("UPDATE operation_delivery SET uncertain=1 WHERE state='pending' AND request_json IS NOT NULL AND message='' AND sequence IN (SELECT sequence FROM pending_operations WHERE workspace_id=?)").run(command.workspaceId); return;
      case "domains": return this.db.prepare("SELECT DISTINCT domain_id FROM local_records WHERE workspace_id=?").all(command.workspaceId).map((row) => String(row.domain_id));
      case "deliveries": return this.db.prepare(`SELECT p.*,d.base_json,d.before_json,d.parent_sequence,d.request_json FROM pending_operations p JOIN operation_delivery d ON p.sequence=d.sequence
        WHERE p.workspace_id=? AND d.state='pending' ORDER BY p.sequence`).all(command.workspaceId).map((row): Delivery => {
          const parent = row.parent_sequence === null ? null : this.db.prepare("SELECT result_json FROM operation_delivery WHERE sequence=?").get(Number(row.parent_sequence));
          return { operation: { workspaceId: command.workspaceId, domainId: String(row.domain_id), recordId: String(row.record_id), operationId: String(row.operation_id),
            kind: row.kind as "put" | "delete", payloadJson: row.payload_json === null ? null : String(row.payload_json), localSequence: Number(row.sequence) },
            base: JSON.parse(String(row.base_json)) as AuthorityVersion | null, before: JSON.parse(String(row.before_json)) as ContentValue,
            parent: parent?.result_json ? JSON.parse(String(parent.result_json)) as AuthorityVersion : null,
            request: row.request_json ? JSON.parse(String(row.request_json)) as UploadRequest : null };
        });
      case "freeze": return this.transaction(() => {
        const row = this.db.prepare("SELECT d.request_json,p.* FROM operation_delivery d JOIN pending_operations p ON p.sequence=d.sequence WHERE d.sequence=? AND d.state='pending'").get(command.sequence);
        if (!row || row.operation_id !== command.request.operationId || row.workspace_id !== command.request.workspaceId || row.record_id !== command.request.recordId || row.domain_id !== command.request.domainId ||
            (row.request_json !== null && canonical(JSON.parse(String(row.request_json))) !== canonical(command.request))) throw new LocalStoreError("operation-mismatch");
        this.db.prepare("UPDATE operation_delivery SET request_json=? WHERE sequence=?").run(JSON.stringify(command.request), command.sequence);
      });
      case "acknowledge-batch": return this.transaction(() => { for (const entry of command.entries) this.execute({ method: "acknowledge", ...entry }); });
      case "acknowledge": return this.transaction(() => {
        const row = this.db.prepare("SELECT p.*,d.state,d.result_json FROM pending_operations p JOIN operation_delivery d ON p.sequence=d.sequence WHERE p.sequence=?").get(command.sequence);
        if (!row || row.workspace_id !== command.version.workspaceId || row.domain_id !== command.version.domainId || row.record_id !== command.version.recordId) throw new LocalStoreError("operation-mismatch");
        if (row.state !== "pending") {
          if (row.result_json && canonical(JSON.parse(String(row.result_json))) === canonical(command.version)) return;
          throw new LocalStoreError("operation-mismatch");
        }
        this.db.prepare("UPDATE operation_delivery SET state='acked',result_json=?,message='' WHERE sequence=?").run(JSON.stringify(command.version), command.sequence);
        this.saveConfirmed(command.version);
        const local = this.local.readRecord(command.version);
        if (local?.localSequence === command.sequence && canonical(local.deleted ? null : local.payload) !== canonical(command.version.value)) this.imported(command.version);
      });
      case "delivery-error": this.db.prepare("UPDATE operation_delivery SET message=?,uncertain=? WHERE sequence=? AND state='pending'").run(command.message, command.uncertain ? 1 : 0, command.sequence); return;
      case "editor": {
        const row = this.db.prepare("SELECT material_json FROM editor_drafts WHERE workspace_id=? AND domain_id=? AND record_id=?").get(...this.args(command.scope));
        return row ? JSON.parse(String(row.material_json)) : null;
      }
      case "save-editor": return this.transaction(() => {
        if (this.local.readRecord(command.draft)?.localSequence !== command.draft.baseSequence) throw new LocalStoreError("operation-mismatch");
        const previous = this.db.prepare("SELECT material_json FROM editor_drafts WHERE workspace_id=? AND domain_id=? AND record_id=?").get(...this.args(command.draft));
        const base = previous ? (JSON.parse(String(previous.material_json)) as import("@workspace/contracts").EditorDraft).base : this.confirmed(command.draft);
        const material = { ...command.draft, base: base ?? null };
        this.db.prepare("INSERT INTO editor_drafts VALUES(?,?,?,?) ON CONFLICT(workspace_id,domain_id,record_id) DO UPDATE SET material_json=excluded.material_json")
          .run(...this.args(command.draft), JSON.stringify(material));
        const conflict = this.local.readConflict(command.draft);
        if (conflict?.status === "pending" && canonical(conflict.editorValue) !== canonical(command.draft.value)) {
          const updated = { ...conflict, generation: conflict.generation + 1, editorValue: command.draft.value };
          this.db.prepare("UPDATE retained_conflicts SET generation=?,material_json=? WHERE workspace_id=? AND domain_id=? AND record_id=?")
            .run(updated.generation, JSON.stringify(updated), ...this.args(command.draft));
        }
      });
      case "clear-editor": this.db.prepare("DELETE FROM editor_drafts WHERE workspace_id=? AND domain_id=? AND record_id=?").run(...this.args(command.scope)); return;
      case "cursor": return Number(this.db.prepare("SELECT cursor FROM replica_cursors WHERE workspace_id=?").get(command.workspaceId)?.cursor ?? 0);
      case "import": return this.transaction(() => {
        const current = this.local.readRecord(command.version);
        if ((current?.localSequence ?? null) !== command.expectedSequence) throw new LocalStoreError("operation-mismatch");
        const pending = this.db.prepare(`SELECT 1 FROM operation_delivery d JOIN pending_operations p ON p.sequence=d.sequence
          WHERE p.workspace_id=? AND p.domain_id=? AND p.record_id=? AND d.state='pending' LIMIT 1`).get(...this.args(command.version));
        const conflict = this.local.readConflict(command.version);
        const editor = this.db.prepare("SELECT 1 FROM editor_drafts WHERE workspace_id=? AND domain_id=? AND record_id=?").get(...this.args(command.version));
        if (!command.preserveLocal && (pending || editor || conflict?.status === "pending")) throw new LocalStoreError("operation-mismatch");
        const prior = this.confirmed(command.version);
        if (!prior || command.version.revision >= prior.revision) {
          this.saveConfirmed(command.version);
          if (!command.preserveLocal && canonical(current?.deleted ? null : current?.payload ?? null) !== canonical(command.version.value)) this.imported(command.version);
          // A new deletion must still create a tombstone if the record was absent.
          else if (!current && !command.preserveLocal) this.imported(command.version);
        }
        this.db.prepare("INSERT INTO replica_cursors VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET cursor=MAX(cursor,excluded.cursor)").run(command.version.workspaceId, command.cursor);
      });
      case "summary": return {
        pending: Number(this.db.prepare("SELECT count(*) AS n FROM operation_delivery d JOIN pending_operations p ON p.sequence=d.sequence WHERE p.workspace_id=? AND d.state='pending'").get(command.workspaceId)?.n ?? 0),
        uncertain: Number(this.db.prepare("SELECT count(*) AS n FROM operation_delivery d JOIN pending_operations p ON p.sequence=d.sequence WHERE p.workspace_id=? AND d.state='pending' AND d.uncertain=1").get(command.workspaceId)?.n ?? 0),
        conflicts: Number(this.db.prepare("SELECT count(*) AS n FROM retained_conflicts WHERE workspace_id=? AND status='pending'").get(command.workspaceId)?.n ?? 0),
        confirmed: Number(this.db.prepare("SELECT count(*) AS n FROM operation_delivery d JOIN pending_operations p ON p.sequence=d.sequence WHERE p.workspace_id=? AND d.state='acked'").get(command.workspaceId)?.n ?? 0),
        cursor: Number(this.db.prepare("SELECT cursor FROM replica_cursors WHERE workspace_id=?").get(command.workspaceId)?.cursor ?? 0),
      };
    }
  }
}
