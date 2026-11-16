import type { ExportInventory } from "@workspace/contracts";
import type { McpStorageCommand } from "@workspace/contracts";
import type { AuthorityVersion, Delivery, EditorDraft, PullPage, RecordScope as SyncScope, ReplicationCommand, UploadRequest, UploadResult, SyncSummary } from "@workspace/contracts";
import type { RetainedConflict, ContentValue } from "@workspace/contracts";


import type { CommitGuard, DomainScope, LocalPersistence, LocalRecord, OperationReference, PendingOperation, PreparedChange, RecordScope } from "@workspace/contracts";
import type { DatabaseOptions } from "../../../packages/adapters/src/sqlite/database.js";



import { LocalDatabase } from "../../../packages/adapters/src/sqlite/database.js";
export class AndroidStore implements LocalPersistence {
  private constructor(private database: LocalDatabase) {}
  static async open(options: DatabaseOptions): Promise<AndroidStore> { return new AndroidStore(new LocalDatabase(options)); }
  private async request(body: any): Promise<any> {
    const d=this.database;
    switch(body.method) {
      case "commit": return d.commit(body.input,body.expectedSequence,body.guard);
      case "read": return d.readRecord(body.input);
      case "operation": return d.readOperation(body.input);
      case "records": return d.listRecords(body.input);
      case "pending": return d.listPending(body.input);
      case "conflict": return d.readConflict(body.input);
      case "conflicts": return d.listConflicts(body.input);
      case "retain": return d.writeConflict(body.input,body.expectedGeneration,body.expectedSequence);
      case "finish-conflict": return d.finishConflict(body.input,body.expectedGeneration,body.expectedSequence,body.record);
      case "replication": return d.replicate(body.input);
      default: throw new Error("Unsupported storage request");
    }
  }
  async commit(change: PreparedChange, expectedSequence?: number | null, guard?: CommitGuard): Promise<number> {
    return await this.request({ method: "commit", input: change, ...(expectedSequence === undefined ? {} : { expectedSequence }), ...(guard ? { guard } : {}) }) as number;
  }

  commitBatch(changes: readonly PreparedChange[], basis: readonly LocalRecord[], guard?: CommitGuard): Promise<readonly number[]> {
    return this.replicate({ method: "local-batch", changes, basis, ...(guard ? { guard } : {}) });
  }
  authorityBatch(request: UploadRequest, values: readonly UploadRequest[], basis: readonly AuthorityVersion[], guards: readonly AuthorityVersion[]): Promise<UploadResult | null> {
    return this.replicate({ method: "authority-batch", request, values, basis, guards });
  }
  importBatch(entries: readonly { version: AuthorityVersion; expectedSequence: number | null; preserveLocal: boolean }[], cursor: number): Promise<void> {
    return this.replicate({ method: "import-batch", entries, cursor });
  }

  finishBatchResolution(conflict: RetainedConflict, versions: readonly AuthorityVersion[], basis: readonly LocalRecord[]): Promise<void> {
    return this.replicate({method:"resolve-batch",conflict,versions,basis});
  }

  async readRecord(scope: RecordScope): Promise<LocalRecord | null> {
    return await this.request({ method: "read", input: scope }) as LocalRecord | null;
  }

  async readOperation(reference: OperationReference): Promise<PendingOperation | null> {
    return await this.request({ method: "operation", input: reference }) as PendingOperation | null;
  }

  async listPending(scope: DomainScope): Promise<readonly PendingOperation[]> {
    return await this.request({ method: "pending", input: scope }) as readonly PendingOperation[];
  }

  async listRecords(scope: DomainScope): Promise<readonly LocalRecord[]> {
    return await this.request({ method: "records", input: scope }) as readonly LocalRecord[];
  }

  async readConflict(scope: RecordScope): Promise<RetainedConflict | null> {
    return await this.request({ method: "conflict", input: scope }) as RetainedConflict | null;
  }
  async listConflicts(scope: DomainScope): Promise<readonly RetainedConflict[]> {
    return await this.request({ method: "conflicts", input: scope }) as readonly RetainedConflict[];
  }
  async writeConflict(value: RetainedConflict, expectedGeneration: number | null, expectedSequence?: number): Promise<void> {
    await this.request({ method: "retain", input: value, expectedGeneration, ...(expectedSequence === undefined ? {} : { expectedSequence }) });
  }
  async finishConflict(value: RetainedConflict, expectedGeneration: number, expectedSequence: number, record: ContentValue): Promise<LocalRecord> {
    return await this.request({ method: "finish-conflict", input: value, expectedGeneration, expectedSequence, record }) as LocalRecord;
  }

async mcp<T = unknown>(command: McpStorageCommand): Promise<T> { return this.replicate<T>({ method: "mcp", command }); }

async authorityList(workspaceId: string, domainId: string): Promise<AuthorityVersion[]> { return this.replicate({ method: "authority-list", workspaceId, domainId }); }

async exportInventory(workspaceId: string, source: "authority" | "local"): Promise<ExportInventory> { return this.replicate({ method: "export-inventory", workspaceId, source }); }

  async snapshot(workspaceId: string, source: "authority" | "local"): Promise<import("@workspace/contracts").WorkspaceSnapshot> { return this.replicate({ method: "snapshot", workspaceId, source }); }

  async authorityControl(workspaceId: string, authorityId: string, action: "status" | "stop" | "activate", isolated = false): Promise<{ state: "active" | "stopped" | "prepared"; workspaceId: string; authorityId: string }> { return this.replicate({ method: "authority-control", workspaceId, authorityId, action, isolated }); }

  private async replicate<T>(input: ReplicationCommand): Promise<T> { return await this.request({ method: "replication", input }) as T; }
  authorityRead(scope: SyncScope, revision?: number): Promise<AuthorityVersion | null> { return this.replicate({ method: "authority-read", scope, ...(revision === undefined ? {} : { revision }) }); }
  authorityChanges(scope: SyncScope, after: number): Promise<readonly string[]> { return this.replicate({ method: "authority-changes", scope, after }); }
  authorityReceipt(request: UploadRequest): Promise<UploadResult | null> { return this.replicate({ method: "authority-receipt", request }); }
  authorityCommit(request: UploadRequest, value: ContentValue, expectedRevision: number, changed: readonly string[], guards: readonly AuthorityVersion[]): Promise<UploadResult | null> {
    return this.replicate({ method: "authority-commit", request, value, expectedRevision, changed, guards });
  }
  authorityPull(workspaceId: string, cursor: number): Promise<PullPage> { return this.replicate({ method: "authority-pull", workspaceId, cursor }); }
  recoverFrozen(workspaceId: string): Promise<void> { return this.replicate({ method: "recover-frozen", workspaceId }); }
  replicaDomains(workspaceId: string): Promise<readonly string[]> { return this.replicate({ method: "domains", workspaceId }); }
  deliveries(workspaceId: string): Promise<readonly Delivery[]> { return this.replicate({ method: "deliveries", workspaceId }); }
  freezeUpload(sequence: number, request: UploadRequest): Promise<void> { return this.replicate({ method: "freeze", sequence, request }); }
  acknowledge(sequence: number, version: AuthorityVersion): Promise<void> { return this.replicate({ method: "acknowledge", sequence, version }); }

  acknowledgeBatch(entries: readonly { sequence: number; version: AuthorityVersion }[]): Promise<void> { return this.replicate({ method: "acknowledge-batch", entries }); }
  deliveryError(sequence: number, message: string, uncertain = false): Promise<void> { return this.replicate({ method: "delivery-error", sequence, message, uncertain }); }
  editor(scope: SyncScope): Promise<EditorDraft | null> { return this.replicate({ method: "editor", scope }); }
  saveEditor(draft: EditorDraft): Promise<void> { return this.replicate({ method: "save-editor", draft }); }
  clearEditor(scope: SyncScope): Promise<void> { return this.replicate({ method: "clear-editor", scope }); }
  confirmed(scope: SyncScope): Promise<AuthorityVersion | null> { return this.replicate({ method: "confirmed", scope }); }
  cursor(workspaceId: string): Promise<number> { return this.replicate({ method: "cursor", workspaceId }); }
  importVersion(version: AuthorityVersion, expectedSequence: number | null, cursor: number, preserveLocal: boolean): Promise<void> {
    return this.replicate({ method: "import", version, expectedSequence, cursor, preserveLocal });
  }
  syncSummary(workspaceId: string): Promise<SyncSummary> { return this.replicate({ method: "summary", workspaceId }); }

  async close(): Promise<void> { this.database.close(); }
}
