import type { ReplicationCommand } from "@workspace/contracts";
import type { RetainedConflict, ContentValue } from "@workspace/contracts";
import type { CommitGuard, DomainScope, OperationReference, PreparedChange, RecordScope } from "@workspace/contracts";

export type StoreRequest = { readonly id: number } & (
  | { readonly method: "commit"; readonly input: PreparedChange; readonly expectedSequence?: number | null; readonly guard?: CommitGuard }
  | { readonly method: "operation"; readonly input: OperationReference }
  | { readonly method: "read"; readonly input: RecordScope }
  | { readonly method: "records"; readonly input: DomainScope }
  | { readonly method: "pending"; readonly input: DomainScope }
  | { readonly method: "conflict"; readonly input: RecordScope }
  | { readonly method: "conflicts"; readonly input: DomainScope }
  | { readonly method: "retain"; readonly input: RetainedConflict; readonly expectedGeneration: number | null; readonly expectedSequence?: number }
  | { readonly method: "finish-conflict"; readonly input: RetainedConflict; readonly expectedGeneration: number; readonly expectedSequence: number; readonly record: ContentValue }
  | { readonly method: "replication"; readonly input: ReplicationCommand }
  | { readonly method: "close" }
);

export type StoreResponse =
  | { readonly type: "ready" }
  | { readonly type: "open-error" }
  | { readonly type: "result"; readonly id: number; readonly value: unknown }
  | { readonly type: "error"; readonly id: number; readonly outcome: "not-saved" | "unconfirmed" | "operation-mismatch" };

