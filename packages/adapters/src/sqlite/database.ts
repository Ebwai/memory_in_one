import { ReplicationDatabase } from "./replication-database.js";
import type { ReplicationCommand } from "@workspace/contracts";
import type { RetainedConflict, ContentValue } from "@workspace/contracts";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { LocalStoreError } from "@workspace/contracts";
import type { CommitGuard, DomainScope, JsonObject, LocalRecord, OperationReference, PendingOperation, PreparedChange, RecordScope } from "@workspace/contracts";
import { APPLICATION_ID, CREATE_SCHEMA, CREATE_CONFLICT_SCHEMA, CREATE_REPLICATION_SCHEMA, CREATE_EDITOR_SCHEMA, CREATE_MCP_SCHEMA, SCHEMA_VERSION } from "./schema.js";

export interface DatabaseOptions {
  readonly databasePath: string;
  readonly readOnly?: boolean;
}

export class LocalDatabase {
  private readonly db: DatabaseSync;

  constructor(options: DatabaseOptions) {
    if (!options.databasePath.trim() || options.databasePath === ":memory:") throw new Error("A durable database path is required");
    const path = resolve(options.databasePath);
    if (!options.readOnly) mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly: options.readOnly ?? false, enableForeignKeyConstraints: true });
    try {
      this.db.exec("PRAGMA busy_timeout = 5000;");
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
      const applicationId = this.db.prepare("PRAGMA application_id").get()?.application_id;
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      if (version === 0 && applicationId === 0 && tables.length === 0 && !options.readOnly) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.exec(CREATE_SCHEMA);
          this.db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      } else if ((version === 1 || version === 2 || version === 3 || version === 4) && applicationId === APPLICATION_ID && !options.readOnly) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const locked = this.db.prepare("PRAGMA user_version").get()?.user_version;
          if (locked === 1) this.db.exec(CREATE_CONFLICT_SCHEMA);
          if (locked === 1 || locked === 2) {
            this.db.exec(CREATE_REPLICATION_SCHEMA);
            this.db.exec(`INSERT INTO operation_delivery(sequence,base_json,before_json,parent_sequence,state)
              SELECT sequence,'null',COALESCE(LAG(COALESCE(payload_json,'null')) OVER(PARTITION BY workspace_id,domain_id,record_id ORDER BY sequence),'null'),
                LAG(sequence) OVER(PARTITION BY workspace_id,domain_id,record_id ORDER BY sequence),'pending' FROM pending_operations`);
          }
          if (locked === 1 || locked === 2 || locked === 3) {
            this.db.exec(CREATE_EDITOR_SCHEMA);
            
          }
          if (Number(locked) < 5) this.db.exec(CREATE_MCP_SCHEMA);
          this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
          this.db.exec("COMMIT");
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      } else if (version !== SCHEMA_VERSION || applicationId !== APPLICATION_ID) {
        throw new Error("Unsupported or unrelated database");
      }
      // Detect incomplete/corrupt schema before reporting a usable store.
      this.db.prepare("SELECT sequence, workspace_id, domain_id, record_id, operation_id, kind, payload_json FROM pending_operations LIMIT 0").all();
      this.db.prepare("SELECT workspace_id, domain_id, record_id, deleted, payload_json, last_sequence FROM local_records LIMIT 0").all();
      this.db.prepare("SELECT generation,status,material_json FROM retained_conflicts LIMIT 0").all();
      this.db.prepare("SELECT sequence,base_json,before_json,uncertain FROM operation_delivery LIMIT 0").all();
      this.db.prepare("SELECT material_json FROM editor_drafts LIMIT 0").all();
      this.db.prepare("SELECT revision,value_json FROM authority_versions LIMIT 0").all();
      if (!options.readOnly) this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  commit(change: PreparedChange, expectedSequence?: number | null, guard?: CommitGuard): number {
    const nested = this.db.isTransaction;
    let began = false;
    try {
      let existing: PendingOperation | null;
      try { existing = this.findOperation(change.workspaceId, change.operationId); }
      catch (cause) { throw new LocalStoreError("unconfirmed", { cause }); }
      if (existing) {
        this.assertSameOperation(existing, change);
        return existing.localSequence;
      }
      if (!nested) this.db.exec("BEGIN IMMEDIATE");
      began = true;
      // Recheck under the write lock: another connection may have committed after
      // the first lookup. Returning a receipt must never replay its old payload.
      existing = this.findOperation(change.workspaceId, change.operationId);
      if (existing) {
        this.assertSameOperation(existing, change);
        if (!nested) this.db.exec("COMMIT");
        return existing.localSequence;
      }
      if (this.db.prepare("SELECT 1 FROM operation_delivery d JOIN pending_operations p ON p.sequence=d.sequence WHERE p.workspace_id=? AND p.domain_id=? AND p.record_id=? AND d.state='pending' AND d.uncertain=1 LIMIT 1").get(change.workspaceId, change.domainId, change.recordId)) throw new LocalStoreError("operation-mismatch");
      if (this.readConflict(change)?.status === "pending") throw new LocalStoreError("operation-mismatch");
      if (guard && this.readRecord(guard.scope)?.localSequence !== guard.localSequence) throw new LocalStoreError("operation-mismatch");
      if (expectedSequence !== undefined) {
        const current = this.readRecord(change);
        if ((current?.localSequence ?? null) !== expectedSequence) throw new LocalStoreError("operation-mismatch");
      }
      const before = this.readRecord(change);
      const inserted = this.db.prepare(`INSERT INTO pending_operations
        (workspace_id, domain_id, record_id, operation_id, kind, payload_json) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(change.workspaceId, change.domainId, change.recordId, change.operationId, change.kind, change.payloadJson);
      const sequence = Number(inserted.lastInsertRowid);
      if (!Number.isSafeInteger(sequence)) throw new Error("Sequence exhausted");
      new ReplicationDatabase(this.db, this).track(change, sequence, before);
      this.db.prepare(`INSERT INTO local_records
        (workspace_id, domain_id, record_id, deleted, payload_json, last_sequence) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, domain_id, record_id) DO UPDATE SET
          deleted = excluded.deleted, payload_json = excluded.payload_json, last_sequence = excluded.last_sequence`)
        .run(change.workspaceId, change.domainId, change.recordId, change.kind === "delete" ? 1 : 0, change.payloadJson, sequence);
      if (!nested) this.db.exec("COMMIT");
      return sequence;
    } catch (cause) {
      if (nested) throw cause;
      if (!began) throw cause instanceof LocalStoreError ? cause : new LocalStoreError("not-saved", { cause });
      try {
        // A failed COMMIT without a live transaction cannot safely be called failure.
        if (!this.db.isTransaction) throw new Error("Commit outcome unknown");
        this.db.exec("ROLLBACK");
      } catch {
        throw new LocalStoreError("unconfirmed", { cause });
      }
      throw cause instanceof LocalStoreError ? cause : new LocalStoreError("not-saved", { cause });
    }
  }

  private findOperation(workspaceId: string, operationId: string): PendingOperation | null {
    const row = this.db.prepare(`SELECT sequence, workspace_id, domain_id, record_id, operation_id, kind, payload_json
      FROM pending_operations WHERE workspace_id = ? AND operation_id = ?`).get(workspaceId, operationId);
    if (!row) return null;
    return { workspaceId: String(row.workspace_id), domainId: String(row.domain_id), recordId: String(row.record_id),
      operationId: String(row.operation_id), kind: row.kind as "put" | "delete",
      payloadJson: row.payload_json === null ? null : String(row.payload_json), localSequence: Number(row.sequence) };
  }

  private assertSameOperation(existing: PendingOperation, change: PreparedChange): void {
    if (existing.domainId !== change.domainId || existing.recordId !== change.recordId || existing.kind !== change.kind ||
      !isDeepStrictEqual(existing.payloadJson === null ? null : JSON.parse(existing.payloadJson),
        change.payloadJson === null ? null : JSON.parse(change.payloadJson))) {
      throw new LocalStoreError("operation-mismatch");
    }
  }

  readOperation(reference: OperationReference): PendingOperation | null {
    const existing = this.findOperation(reference.workspaceId, reference.operationId);
    return existing?.domainId === reference.domainId && existing.recordId === reference.recordId ? existing : null;
  }

  readRecord(scope: RecordScope): LocalRecord | null {
    const row = this.db.prepare(`SELECT deleted, payload_json, last_sequence FROM local_records
      WHERE workspace_id = ? AND domain_id = ? AND record_id = ?`).get(scope.workspaceId, scope.domainId, scope.recordId);
    if (!row) return null;
    const uncertain = this.db.prepare("SELECT 1 FROM operation_delivery d JOIN pending_operations p ON p.sequence=d.sequence WHERE p.workspace_id=? AND p.domain_id=? AND p.record_id=? AND d.state='pending' AND d.uncertain=1 LIMIT 1").get(scope.workspaceId, scope.domainId, scope.recordId);
    return { ...scope, ...(uncertain ? { pendingConfirmation: true } : {}), deleted: row.deleted === 1, payload: row.payload_json === null ? null : JSON.parse(String(row.payload_json)) as JsonObject,
      localSequence: Number(row.last_sequence) };
  }

  listPending(scope: DomainScope): readonly PendingOperation[] {
    return this.db.prepare(`SELECT sequence, record_id, operation_id, kind, payload_json FROM pending_operations
      WHERE workspace_id = ? AND domain_id = ? ORDER BY sequence`).all(scope.workspaceId, scope.domainId)
      .map((row) => ({ ...scope, recordId: String(row.record_id), operationId: String(row.operation_id),
        kind: row.kind as "put" | "delete", payloadJson: row.payload_json === null ? null : String(row.payload_json),
        localSequence: Number(row.sequence) }));
  }

  listRecords(scope: DomainScope): readonly LocalRecord[] {
    return this.db.prepare("SELECT record_id, deleted, payload_json, last_sequence FROM local_records WHERE workspace_id = ? AND domain_id = ? ORDER BY last_sequence")
      .all(scope.workspaceId, scope.domainId).map((row) => ({ ...scope, recordId: String(row.record_id), deleted: row.deleted === 1,
        payload: row.payload_json === null ? null : JSON.parse(String(row.payload_json)) as JsonObject, localSequence: Number(row.last_sequence) }));
  }

  readConflict(scope: RecordScope): RetainedConflict | null {
    const row = this.db.prepare("SELECT material_json FROM retained_conflicts WHERE workspace_id=? AND domain_id=? AND record_id=?")
      .get(scope.workspaceId, scope.domainId, scope.recordId);
    return row ? JSON.parse(String(row.material_json)) as RetainedConflict : null;
  }

  listConflicts(scope: DomainScope): readonly RetainedConflict[] {
    return this.db.prepare("SELECT material_json FROM retained_conflicts WHERE workspace_id=? AND domain_id=? AND status='pending' ORDER BY record_id")
      .all(scope.workspaceId, scope.domainId).map((row) => JSON.parse(String(row.material_json)) as RetainedConflict);
  }

  writeConflict(value: RetainedConflict, expectedGeneration: number | null, expectedSequence?: number): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if ((this.readConflict(value)?.generation ?? null) !== expectedGeneration || value.generation !== (expectedGeneration ?? 0) + 1 ||
          (expectedSequence !== undefined && this.readRecord(value)?.localSequence !== expectedSequence)) throw new LocalStoreError("operation-mismatch");
      if (expectedGeneration === null) {
        const record = this.readRecord(value);
        if (!record || !isDeepStrictEqual(record.deleted ? null : record.payload, value.comparison.local.value)) throw new LocalStoreError("operation-mismatch");
      }
      this.db.prepare(`INSERT INTO retained_conflicts(workspace_id,domain_id,record_id,generation,status,material_json) VALUES(?,?,?,?,?,?)
        ON CONFLICT(workspace_id,domain_id,record_id) DO UPDATE SET generation=excluded.generation,status=excluded.status,material_json=excluded.material_json`)
        .run(value.workspaceId, value.domainId, value.recordId, value.generation, value.status, JSON.stringify(value));
      this.db.exec("COMMIT");
    } catch (cause) {
      if (!this.db.isTransaction) throw new LocalStoreError("unconfirmed", { cause });
      try { this.db.exec("ROLLBACK"); }
      catch { throw new LocalStoreError("unconfirmed", { cause }); }
      throw cause instanceof LocalStoreError ? cause : new LocalStoreError("not-saved", { cause });
    }
  }

  finishConflict(value: RetainedConflict, expectedGeneration: number, expectedSequence: number, record: ContentValue): LocalRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.readConflict(value);
      if (current?.status === "resolved" && current.draft?.operationId === value.draft?.operationId) {
        this.db.exec("COMMIT"); return this.readRecord(value)!;
      }
      if (value.status !== "resolved" || value.generation !== expectedGeneration + 1 || !current || current.generation !== expectedGeneration || current.status !== "pending" ||
          !current.draft?.submitted || current.draft.operationId !== value.draft?.operationId ||
          !isDeepStrictEqual(current.draft.value, record) || this.readRecord(value)?.localSequence !== expectedSequence) throw new LocalStoreError("operation-mismatch");
      const change: PreparedChange = { workspaceId: value.workspaceId, domainId: value.domainId, recordId: value.recordId,
        operationId: current.draft.operationId, kind: record === null ? "delete" : "put", payloadJson: record === null ? null : JSON.stringify(record) };
      const existing = this.findOperation(value.workspaceId, change.operationId);
      if (existing) throw new LocalStoreError("operation-mismatch");
      const inserted = this.db.prepare("INSERT INTO pending_operations(workspace_id,domain_id,record_id,operation_id,kind,payload_json) VALUES(?,?,?,?,?,?)")
        .run(change.workspaceId, change.domainId, change.recordId, change.operationId, change.kind, change.payloadJson);
      const sequence = Number(inserted.lastInsertRowid);
      if (!Number.isSafeInteger(sequence)) throw new Error("Sequence exhausted");
      this.db.prepare("UPDATE local_records SET deleted=?,payload_json=?,last_sequence=? WHERE workspace_id=? AND domain_id=? AND record_id=?")
        .run(record === null ? 1 : 0, change.payloadJson, sequence, value.workspaceId, value.domainId, value.recordId);
      new ReplicationDatabase(this.db, this).resolved(value, sequence);
      this.db.prepare("UPDATE retained_conflicts SET generation=?,status='resolved',material_json=? WHERE workspace_id=? AND domain_id=? AND record_id=?")
        .run(value.generation, JSON.stringify(value), value.workspaceId, value.domainId, value.recordId);
      this.db.exec("COMMIT");
      return { workspaceId: value.workspaceId, domainId: value.domainId, recordId: value.recordId, deleted: record === null, payload: record, localSequence: sequence };
    } catch (cause) {
      if (!this.db.isTransaction) throw new LocalStoreError("unconfirmed", { cause });
      try { this.db.exec("ROLLBACK"); }
      catch { throw new LocalStoreError("unconfirmed", { cause }); }
      throw cause instanceof LocalStoreError ? cause : new LocalStoreError("not-saved", { cause });
    }
  }

  replicate(command: ReplicationCommand): unknown { return new ReplicationDatabase(this.db, this).execute(command); }

  close(): void {
    this.db.close();
  }
}

