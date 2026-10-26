import type { ExportInventory, ExportScope, WorkspaceIdentity } from "@workspace/contracts";

export function describeExportScope(workspace: WorkspaceIdentity, source: "authority" | "local", location: string, inventory: ExportInventory, observedAt: string): ExportScope {
  if (!workspace.workspaceId || !workspace.authorityId || !["authority", "local"].includes(source)) throw new Error("无法核对导出来源与空间身份。");
  return { ...inventory, workspace, source, location, observedAt,
    includes: ["该来源持有的全部领域登记、配置、内容和原身份（含停用或缺程序领域）", "当前进度、必要删除接续信息及操作结果", "该来源已可靠保存的冲突与整理材料、MCP 调用记录和授权定义参考", ...(source === "local" ? ["本机未同步操作及已取得的统一进度"] : [])],
    limitations: [source === "authority" ? "不包含其他设备尚未上传的成果。" : "本机可恢复数据，不代表统一位置最新全量状态。", "普通未提交输入须先在原领域保存才可纳入。", "其他离线设备的未知改动不声称已包含。", "原地址仅作来源说明，恢复后不能自动成为写入目标；访问凭据和接入授权须重新验证。", "本步骤仅确认范围；尚未生成导出文件。"] };
}
