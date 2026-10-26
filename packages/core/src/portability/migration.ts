import type { WorkspaceIdentity } from "@workspace/contracts";

/** Product boundary shared by local and remote migration hosts. */
export function confirmMigrationBoundary(original: WorkspaceIdentity, target: WorkspaceIdentity, oldState: "active" | "stopped" | "unreachable", isolated: boolean): void {
  if (original.workspaceId !== target.workspaceId || original.authorityId !== target.authorityId) throw new Error("迁移目标不是原工作空间。");
  if (oldState === "active") throw new Error("旧位置仍可写，请先停止写入，再导出并恢复目标。");
  if (oldState === "unreachable" && !isolated) throw new Error("无法核对旧位置，请明确确认其已停用或隔离及材料覆盖边界。");
}
