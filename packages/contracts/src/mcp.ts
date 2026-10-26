import type { UploadRequest } from "./replication.js";
import type { JsonObject } from "./local-persistence.js";

export interface McpCall {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly domainId: string;
  readonly action: string;
  readonly recordId: string;
  readonly summary: string;
  readonly time: string;
  readonly confirmed: boolean;
  readonly status: "pending-confirmation" | "unconfirmed" | "failed" | "conflict" | "succeeded" | "cancelled";
  readonly result: JsonObject;
}

export interface McpGrant {
  readonly workspaceId: string;
  readonly id: string;
  readonly name: string;
  readonly domains: readonly string[];
  readonly actions: readonly string[];
  readonly revoked: boolean;
}
export interface McpPrepared {
  readonly key: string;
  readonly request: UploadRequest;
  readonly challenge: string | null;
  readonly confirmation: "pending" | "accepted" | "declined" | "unneeded";
}
export type McpStorageCommand =
  | { method: "host-get"; workspaceId: string; domainId: string }
  | { method: "host-set"; workspaceId: string; domainId: string; available: boolean; audit: McpCall }
  | { method: "prepare"; prepared: McpPrepared }
  | { method: "prepared"; workspaceId: string; operationId: string }
  | { method: "confirm"; workspaceId: string; operationId: string; challenge: string; accepted: boolean }
  | { method: "grant-create"; grant: McpGrant; secretHash: string; audit: McpCall }
  | { method: "grant-revoke"; workspaceId: string; id: string; audit: McpCall }
  | { method: "grant-list"; workspaceId: string }
  | { method: "grant-auth"; workspaceId: string; secretHash: string }
  | { method: "call-save"; call: McpCall }
  | { method: "call-list"; workspaceId: string; sourceId?: string }
  | { method: "call-read"; workspaceId: string; operationId: string };
