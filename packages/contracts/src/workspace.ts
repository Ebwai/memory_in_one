export interface WorkspaceIdentity {
  readonly workspaceId: string;
  readonly authorityId: string;
  readonly name: string;
  readonly creationId: string;
  readonly createdAt: string;
}
export interface WorkspaceProposal extends WorkspaceIdentity {}
export type WorkspaceCreateResult =
  | { readonly status: "created"; readonly workspace: WorkspaceIdentity }
  | { readonly status: "rejected"; readonly reason: "invalid-input" | "target-occupied" | "request-mismatch" | "unauthorized" | "unavailable"; readonly message: string }
  | { readonly status: "unconfirmed"; readonly message: string };
export interface WorkspaceCreationPort {
  create(proposal: WorkspaceProposal): Promise<WorkspaceCreateResult>;
  inspect(): Promise<WorkspaceIdentity | null>;
}
export interface WorkspaceCreationRequest { readonly creationId: string; readonly name: string }

