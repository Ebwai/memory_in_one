import type { SyncSummary } from "@workspace/contracts";
export interface SyncScreen extends SyncSummary { readonly phase: "pending" | "syncing" | "synced" | "failed" | "unconfirmed" | "conflict"; readonly message: string; readonly lastSuccessAt: string | null }
import type { WorkspaceCreateResult, WorkspaceIdentity } from "@workspace/contracts";
export interface WorkspaceForm {
  readonly creationId: string; readonly name: string; readonly kind: "local" | "remote";
  readonly directory: string; readonly url: string;
}
export interface WorkspaceBinding {
  readonly workspace: WorkspaceIdentity; readonly kind: "local" | "remote"; readonly location: string;
  readonly endpoint: string; readonly replicaPath: string;
}
export interface WorkspaceScreen {
  readonly binding: WorkspaceBinding | null; readonly pending: WorkspaceForm | null;
  readonly defaultDirectory: string; readonly error: string | null;
  readonly pendingOutcome: "pending" | "rejected" | "unconfirmed" | null;
}
export type WorkspaceScreenResult = WorkspaceCreateResult & { readonly binding?: WorkspaceBinding };
export interface ConnectionForm {
  readonly kind: "local" | "remote"; readonly directory: string; readonly url: string; readonly token: string;
}
export type ConnectionResult =
  | { readonly status: "verified"; readonly ticket: string; readonly workspace: WorkspaceIdentity; readonly location: string }
  | { readonly status: "connected"; readonly binding: WorkspaceBinding }
  | { readonly status: "rejected"; readonly message: string };
export type DomainResponse = { readonly ok: false; readonly outcome?: "not-saved" | "unconfirmed"; readonly message: string } | { readonly ok: true; readonly conflicts?: readonly import("@workspace/contracts").RetainedConflict[]; readonly conflict?: import("@workspace/contracts").RetainedConflict; readonly message?: string; readonly domains?: readonly import("@workspace/contracts").DomainEntry[]; readonly save?: import("@workspace/contracts").LocalSaveResult; readonly workspaceId?: string; readonly record?: import("@workspace/contracts").LocalRecord | null; readonly records?: readonly import("@workspace/contracts").LocalRecord[]; readonly preview?: import("@workspace/contracts").ExtensionDefinition };
export interface WorkspaceBridge {
  update(action: import("./update-contracts.js").UpdateAction): Promise<import("./update-contracts.js").UpdateScreen>;
  migration(action: "status" | "stop" | "switch", target?: ConnectionForm & { isolated: boolean }): Promise<{ message: string; state?: string; binding?: WorkspaceBinding }>;
  recovery(action: "preview" | "restore" | "use-local", ticket?: string): Promise<{ ticket: string; summary: import("@workspace/adapters").RecoverySummary; binding?: WorkspaceBinding } | null>;
  exportFile(source: "authority" | "local"): Promise<{ cancelled: boolean; path?: string; capturedAt?: string }>;
  exportScope(source: "authority" | "local"): Promise<import("@workspace/contracts").ExportScope>;
  mcp(method: "grants" | "calls" | "directory" | "grant-create" | "grant-revoke", input?: import("@workspace/contracts").JsonObject): Promise<unknown>;
  sync(action: "status" | "now"): Promise<SyncScreen>;
  windowAction(action: "floating" | "management" | "pin" | "unpin" | "close"): Promise<void>;
  onCloseRequested(listener: () => void): () => void;
  domains(request: { draft?: import("@workspace/contracts").JsonObject; generation?: number; choice?: import("@workspace/contracts").ResolutionChoice; submitted?: boolean; action: string; source?: string; operationId?: string; domainId?: string; recordId?: string; text?: string; createdAt?: string; payload?: import("@workspace/contracts").JsonObject; workspaceId?: string; baseSequence?: number; command?: import("@workspace/todo-list").TodoCommand; at?: string }): Promise<DomainResponse>;
  inspect(form: ConnectionForm): Promise<ConnectionResult>;
  connect(ticket: string): Promise<ConnectionResult>;
  load(): Promise<WorkspaceScreen>;
  chooseDirectory(): Promise<string | null>;
  create(form: WorkspaceForm & { readonly token: string }): Promise<WorkspaceScreenResult>;
}

