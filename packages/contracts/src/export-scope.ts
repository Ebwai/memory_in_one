import type { JsonObject } from "./local-persistence.js";
import type { WorkspaceIdentity } from "./workspace.js";

export interface ExportInventory {
  readonly domains: readonly { readonly domainId: string; readonly registration: JsonObject | null; readonly records: number; readonly deletions: number }[];
  readonly pending: number;
  readonly uncertain: number;
  readonly conflicts: number;
  readonly savedEditing: number;
  readonly calls: number;
}
export interface ExportScope extends ExportInventory {
  readonly workspace: WorkspaceIdentity;
  readonly source: "authority" | "local";
  readonly location: string;
  readonly observedAt: string;
  readonly includes: readonly string[];
  readonly limitations: readonly string[];
}
