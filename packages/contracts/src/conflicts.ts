import type { DomainScope, JsonObject, LocalRecord, RecordScope } from "./local-persistence.js";

// null is an explicit tombstone; an unavailable snapshot is represented by a
// missing Version, never by pretending that the other side deleted the content.
export type ContentValue = JsonObject | null;
export interface ConfirmedVersion { readonly revision: number; readonly value: ContentValue }
export interface ContentBranch {
  readonly baseRevision: number;
  readonly value: ContentValue;
  // Includes semantic changes such as complete -> restore, even if final values
  // match the base. The producer derives these from operations, not wall clocks.
  readonly changed: readonly string[];
}
export interface ConflictPolicy {
  readonly attributes: Readonly<Record<string, readonly string[]>>;
  validate(value: ContentValue, base: ContentValue): void;
  compatible?(attribute: string, local: JsonObject, remote: JsonObject): boolean;
}
export interface Comparison extends RecordScope {
  readonly base: ConfirmedVersion | null;
  readonly local: ContentBranch;
  readonly remote: ConfirmedVersion | null;
  readonly remoteChanged: readonly string[];
}
export type MergeDecision = { readonly status: "merged"; readonly value: ContentValue }
  | { readonly status: "conflict"; readonly reasons: readonly string[] };
export type ResolutionChoice = { readonly kind: "local" | "remote" | "delete" }
  | { readonly kind: "manual" | "restore"; readonly value: JsonObject };
export interface ResolutionDraft {
  readonly operationId: string;
  readonly atomicRequest?: import("./replication.js").UploadRequest;
  readonly comparedRevision: number;
  readonly choice: ResolutionChoice;
  readonly value: ContentValue;
  readonly submitted: boolean;
}
export interface RetainedConflict extends RecordScope {
  readonly atomicGroup?: { readonly request: import("./replication.js").UploadRequest; readonly sequences: readonly number[]; readonly records?: readonly string[] };
  readonly editorValue?: JsonObject;
  readonly generation: number;
  readonly comparison: Comparison;
  readonly reasons: readonly string[];
  readonly remoteHistory: readonly ConfirmedVersion[];
  readonly draft: ResolutionDraft | null;
  readonly status: "pending" | "resolved";
}
export interface ConflictPersistence {
  readConflict(scope: RecordScope): Promise<RetainedConflict | null>;
  listConflicts(scope: DomainScope): Promise<readonly RetainedConflict[]>;
  // CAS on generation, and optionally on local content, under one write lock.
  writeConflict(value: RetainedConflict, expectedGeneration: number | null, expectedSequence?: number): Promise<void>;
  // Called only with an authority-confirmed result. Resolution and content become
  // visible together; a lost reply can be checked through the same operation ID.
  finishConflict(value: RetainedConflict, expectedGeneration: number, expectedSequence: number, record: ContentValue): Promise<LocalRecord>;
}
