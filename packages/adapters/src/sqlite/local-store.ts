import type { ExportInventory } from "@workspace/contracts";
import type { McpStorageCommand } from "@workspace/contracts";
import type { AuthorityVersion, Delivery, EditorDraft, PullPage, RecordScope as SyncScope, ReplicationCommand, UploadRequest, UploadResult, SyncSummary } from "@workspace/contracts";
import type { RetainedConflict, ContentValue } from "@workspace/contracts";
import { Worker } from "node:worker_threads";
import { LocalStoreError } from "@workspace/contracts";
import type { CommitGuard, DomainScope, LocalPersistence, LocalRecord, OperationReference, PendingOperation, PreparedChange, RecordScope } from "@workspace/contracts";
import type { DatabaseOptions } from "./database.js";
import type { StoreRequest, StoreResponse } from "./protocol.js";

type ResultValue = Extract<StoreResponse, { type: "result" }>["value"];
type RequestBody = StoreRequest extends infer R ? R extends StoreRequest ? Omit<R, "id"> : never : never;

export class SqliteLocalStore implements LocalPersistence {
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<number, { resolve: (value: ResultValue) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private closed = false;
  private failed = false;
  private closing: Promise<void> | undefined;

  private constructor(options: DatabaseOptions) {
    this.worker = new Worker(new URL("./worker.js", import.meta.url), { workerData: options });
    this.ready = new Promise<void>((resolve, reject) => {
      const fail = (): void => {
        this.failed = true;
        reject(new LocalStoreError("not-saved"));
        for (const request of this.pending.values()) request.reject(new LocalStoreError("unconfirmed"));
        this.pending.clear();
      };
      this.worker.on("message", (response: StoreResponse) => {
        if (response.type === "ready") { resolve(); return; }
        if (response.type === "open-error") { fail(); return; }
        const request = this.pending.get(response.id);
        if (!request) return;
        this.pending.delete(response.id);
        if (response.type === "error") request.reject(new LocalStoreError(response.outcome));
        else request.resolve(response.value);
      });
      this.worker.on("error", fail);
      this.worker.on("exit", fail);
    });
  }

  static async open(options: DatabaseOptions): Promise<SqliteLocalStore> {
    const store = new SqliteLocalStore(options);
    try { await store.ready; return store; }
    catch (error) { await store.worker.terminate(); throw error; }
  }

  private request(body: RequestBody): Promise<ResultValue> {
    if (this.closed || this.failed) return Promise.reject(new LocalStoreError("not-saved"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ ...body, id }); }
      catch (cause) {
        this.pending.delete(id);
        reject(new LocalStoreError("not-saved", { cause }));
      }
    });
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

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const closing = this.request({ method: "close" });
    this.closed = true;
    this.closing = closing.then(() => undefined).finally(async () => { await this.worker.terminate(); });
    return this.closing;
  }
}

