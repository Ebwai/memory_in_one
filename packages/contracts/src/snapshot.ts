import type { JsonObject } from "./local-persistence.js";

/** N51: rows retain operation/revision identities; restoration must never replay them. */
export interface WorkspaceSnapshot {
  readonly format: "workspace-snapshot";
  readonly version: 1;
  readonly schemaVersion: number;
  readonly workspaceId: string;
  readonly source: "authority" | "local";
  readonly revisionFloor: number;
  readonly authorityState: "active" | "stopped" | "prepared";
  readonly capturedAt: string;
  readonly tables: Readonly<Record<string, readonly JsonObject[]>>;
}
