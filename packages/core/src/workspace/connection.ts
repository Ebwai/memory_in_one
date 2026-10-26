import type { WorkspaceIdentity, WorkspaceCreationPort } from "@workspace/contracts";

/** N06: both stable identities must match; names are display data only. */
export async function inspectExistingWorkspace(
  location: Pick<WorkspaceCreationPort, "inspect">,
  expected: WorkspaceIdentity | null,
): Promise<WorkspaceIdentity> {
  const identity = await location.inspect();
  if (!identity) throw new Error("该位置不存在工作空间，请检查地址；未创建新空间。");
  if (expected && (identity.workspaceId !== expected.workspaceId || identity.authorityId !== expected.authorityId)) {
    throw new Error("目标空间身份与原空间不一致，已停止接入并保留原绑定与本机进度。");
  }
  return identity;
}
