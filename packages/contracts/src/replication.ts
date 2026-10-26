import type { McpCall, McpStorageCommand } from "./mcp.js";
import type { ConfirmedVersion, ContentValue, ConflictPolicy } from "./conflicts.js";
import type { JsonObject, PendingOperation, RecordScope } from "./local-persistence.js";
import type { WorkspaceIdentity } from "./workspace.js";

export interface AuthorityVersion extends ConfirmedVersion, RecordScope { readonly changed: readonly string[]; readonly related?: readonly AuthorityVersion[] | undefined }
export interface UploadRequest extends RecordScope {
  readonly authorityId: string;
  readonly operationId: string;
  readonly baseRevision: number;
  readonly value: ContentValue;
  readonly changed: readonly string[];
  readonly resolution: boolean;
  readonly audit?: McpCall;
  readonly batch?: readonly UploadRequest[] | undefined;
}
export type UploadResult = { readonly status: "accepted"; readonly version: AuthorityVersion }
  | { readonly status: "conflict"; readonly version: AuthorityVersion; readonly base: AuthorityVersion | null; readonly reasons: readonly string[] }
  | { readonly status: "rejected"; readonly message: string };
export interface PullPage { readonly versions: readonly AuthorityVersion[]; readonly cursor: number; readonly more: boolean }
export interface SyncRemote {
  inspect(): Promise<WorkspaceIdentity | null>;
  upload(request: UploadRequest): Promise<UploadResult>;
  pull(workspaceId: string, authorityId: string, cursor: number): Promise<PullPage>;
}
export interface Delivery {
  readonly operation: PendingOperation;
  readonly base: AuthorityVersion | null;
  readonly before: ContentValue;
  readonly parent: AuthorityVersion | null;
  readonly request: UploadRequest | null;
}
export interface AuthorityPersistence {
  authorityRead(scope: RecordScope, revision?: number): Promise<AuthorityVersion | null>;
  authorityChanges(scope: RecordScope, after: number): Promise<readonly string[]>;
  authorityReceipt(request: UploadRequest): Promise<UploadResult | null>;
  authorityCommit(request: UploadRequest, result: ContentValue, expectedRevision: number, changed: readonly string[], guards: readonly AuthorityVersion[]): Promise<UploadResult | null>;
  authorityPull(workspaceId: string, cursor: number): Promise<PullPage>;
  authorityList?(workspaceId: string, domainId: string): Promise<AuthorityVersion[]>;
  authorityBatch?(request: UploadRequest, values: readonly UploadRequest[], basis: readonly AuthorityVersion[], guards: readonly AuthorityVersion[]): Promise<UploadResult | null>;
}
export interface ReplicaPersistence {
  recoverFrozen(workspaceId: string): Promise<void>;
  replicaDomains(workspaceId: string): Promise<readonly string[]>;
  deliveries(workspaceId: string): Promise<readonly Delivery[]>;
  freezeUpload(sequence: number, request: UploadRequest): Promise<void>;
  acknowledge(sequence: number, result: AuthorityVersion): Promise<void>;
  acknowledgeBatch?(entries: readonly { sequence: number; version: AuthorityVersion }[]): Promise<void>;
  finishBatchResolution?(conflict: import("./conflicts.js").RetainedConflict, versions: readonly AuthorityVersion[], basis: readonly import("./local-persistence.js").LocalRecord[]): Promise<void>;
  importBatch?(entries: readonly { version: AuthorityVersion; expectedSequence: number | null; preserveLocal: boolean }[], cursor: number): Promise<void>;
  deliveryError(sequence: number, message: string, uncertain?: boolean): Promise<void>;
  editor(scope: RecordScope): Promise<EditorDraft | null>;
  saveEditor(draft: EditorDraft): Promise<void>;
  clearEditor(scope: RecordScope): Promise<void>;
  confirmed(scope: RecordScope): Promise<AuthorityVersion | null>;
  cursor(workspaceId: string): Promise<number>;
  importVersion(version: AuthorityVersion, expectedSequence: number | null, cursor: number, preserveLocal: boolean): Promise<void>;
  syncSummary(workspaceId: string): Promise<SyncSummary>;
}
export interface EditorDraft extends RecordScope { readonly base?: ConfirmedVersion | null; readonly baseSequence: number; readonly value: JsonObject; readonly operationId: string }
export interface SyncSummary { readonly pending: number; readonly uncertain: number; readonly conflicts: number; readonly confirmed: number; readonly cursor: number }
export interface DomainHandler {
  readonly policy?: ConflictPolicy;
  validate(value: ContentValue, base: ContentValue, creating: boolean): void;
  readonly guards: readonly AuthorityVersion[];
  validateCollection?(values: readonly { recordId: string; value: ContentValue }[]): void;
}
export type ReplicationCommand = { readonly method: "mcp"; readonly command: McpStorageCommand }
  | { readonly method: "local-batch"; readonly changes: readonly import("./local-persistence.js").PreparedChange[]; readonly basis: readonly import("./local-persistence.js").LocalRecord[]; readonly guard?: import("./local-persistence.js").CommitGuard }
  | { readonly method: "authority-batch"; readonly request: UploadRequest; readonly values: readonly UploadRequest[]; readonly basis: readonly AuthorityVersion[]; readonly guards: readonly AuthorityVersion[] }
  | { readonly method: "resolve-batch"; readonly conflict: import("./conflicts.js").RetainedConflict; readonly versions: readonly AuthorityVersion[]; readonly basis: readonly import("./local-persistence.js").LocalRecord[] }
  | { readonly method: "import-batch"; readonly entries: readonly { version: AuthorityVersion; expectedSequence: number | null; preserveLocal: boolean }[]; readonly cursor: number }
  | { readonly method: "authority-control"; readonly action: "status" | "stop" | "activate"; readonly workspaceId: string; readonly authorityId: string; readonly isolated?: boolean }
  | { readonly method: "snapshot"; readonly workspaceId: string; readonly source: "authority" | "local" }
  | { readonly method: "export-inventory"; readonly workspaceId: string; readonly source: "authority" | "local" }
  | { readonly method: "authority-list"; readonly workspaceId: string; readonly domainId: string }
  | { readonly method: "authority-read"; readonly scope: RecordScope; readonly revision?: number }
  | { readonly method: "authority-changes"; readonly scope: RecordScope; readonly after: number }
  | { readonly method: "authority-receipt"; readonly request: UploadRequest }
  | { readonly method: "authority-commit"; readonly request: UploadRequest; readonly value: ContentValue; readonly expectedRevision: number; readonly changed: readonly string[]; readonly guards: readonly AuthorityVersion[] }
  | { readonly method: "authority-pull"; readonly workspaceId: string; readonly cursor: number }
  | { readonly method: "recover-frozen"; readonly workspaceId: string }
  | { readonly method: "domains"; readonly workspaceId: string }
  | { readonly method: "deliveries"; readonly workspaceId: string }
  | { readonly method: "freeze"; readonly sequence: number; readonly request: UploadRequest }
  | { readonly method: "acknowledge-batch"; readonly entries: readonly { sequence: number; version: AuthorityVersion }[] }
  | { readonly method: "acknowledge"; readonly sequence: number; readonly version: AuthorityVersion }
  | { readonly method: "delivery-error"; readonly sequence: number; readonly message: string; readonly uncertain: boolean }
  | { readonly method: "editor" | "clear-editor"; readonly scope: RecordScope }
  | { readonly method: "save-editor"; readonly draft: EditorDraft }
  | { readonly method: "confirmed"; readonly scope: RecordScope }
  | { readonly method: "cursor" | "summary"; readonly workspaceId: string }
  | { readonly method: "import"; readonly version: AuthorityVersion; readonly expectedSequence: number | null; readonly cursor: number; readonly preserveLocal: boolean };

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical((value as JsonObject)[key])).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
