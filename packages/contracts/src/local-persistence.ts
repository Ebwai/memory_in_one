export interface RecordScope {
  readonly workspaceId: string;
  readonly domainId: string;
  readonly recordId: string;
}

export interface DomainScope {
  readonly workspaceId: string;
  readonly domainId: string;
}

export interface OperationReference extends RecordScope {
  readonly operationId: string;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type LocalChange = RecordScope & { readonly operationId: string } & (
  | { readonly kind: "put"; readonly payload: JsonObject }
  | { readonly kind: "delete" }
);

export interface PreparedChange extends RecordScope {
  readonly operationId: string;
  readonly kind: "put" | "delete";
  readonly payloadJson: string | null;
}

export interface LocalRecord extends RecordScope {
  readonly pendingConfirmation?: boolean;
  readonly deleted: boolean;
  readonly payload: JsonObject | null;
  readonly localSequence: number;
}

export interface PendingOperation extends PreparedChange {
  readonly localSequence: number;
}

export type LocalSaveResult =
  | { readonly status: "saved-local"; readonly operationId: string; readonly localSequence: number }
  | { readonly status: "not-saved"; readonly reason: "invalid-input" | "storage-unavailable" | "operation-mismatch"; readonly message: string }
  | { readonly status: "save-unconfirmed"; readonly operationId: string; readonly message: string };

export class LocalStoreError extends Error {
  constructor(
    readonly outcome: "not-saved" | "unconfirmed" | "operation-mismatch",
    options?: ErrorOptions,
  ) {
    super(outcome === "operation-mismatch" ? "Operation identity belongs to a different change."
      : outcome === "not-saved" ? "Local storage did not commit." : "Local commit outcome is unknown.", options);
    this.name = "LocalStoreError";
  }
}

export interface CommitGuard { readonly scope: RecordScope; readonly localSequence: number }
export interface LocalPersistence {
  commit(change: PreparedChange, expectedSequence?: number | null, guard?: CommitGuard): Promise<number>;
  commitBatch?(changes: readonly PreparedChange[], basis: readonly LocalRecord[], guard?: CommitGuard): Promise<readonly number[]>;
  listRecords(scope: DomainScope): Promise<readonly LocalRecord[]>;
  readOperation(reference: OperationReference): Promise<PendingOperation | null>;
  readRecord(scope: RecordScope): Promise<LocalRecord | null>;
  listPending(scope: DomainScope): Promise<readonly PendingOperation[]>;
  close(): Promise<void>;
}

