---
paths:
  - "packages/core/src/portability/**/*"
  - "packages/contracts/src/export-scope.ts"
  - "packages/adapters/src/sqlite/**/*"
  - "apps/desktop/**/*"
  - "apps/server/**/*"
---
# 导出范围确认（N50）

## 模块概览
承接核心 portability、SQLite 和桌面导出入口，统一位置范围由所有者认证服务读取，本机范围只读原绑定副本，可离线使用。本节点交付范围预览与明确确认，N51–N62 的快照、文件交付、恢复及迁移接续见 [数据携带设计](portability.md)。

## API 与数据语义
ExportScope 标明空间、权威身份、来源位置、读取时点、领域登记及数据归属、待同步和冲突统计。范围覆盖所选来源持有的全部领域，既有停用和未知领域均保留；未提交输入不纳入，已保存的冲突整理材料纳入。凭据、有效授权秘密、主机程序安装状态不能被当作可恢复授权。

## 关键流程与异常
选择来源 → 从该来源事务读取范围统计 → 展示范围和限制 → 用户明确确认该预览。统一位置失败不替换成本机来源，需用户主动切换。本机预览不调用网络。可先请求既有立即同步，再重新预览；仍不能声称其他离线设备的数据已包含。确认仅记录当前界面已审阅范围，不构成数据文件或固定快照，后续快照阶段须重新校验所选身份与来源。

## 测试
验证离线本机、不可达权威、停用/未知领域、待同步/冲突统计和凭据排除。普通编辑保护未提交输入不计入冲突整理材料数量；已保存的冲突 editorValue 或 draft 计入。完整文件及恢复验证由 N51–N62 的数据携带验收承接。

## 实现锚点
contracts/export-scope.ts 与 core/portability/export-scope.ts 定义来源范围；SqliteLocalStore.exportInventory 经 worker 读取同一事务中的登记、原始领域归属及统计，不以界面筛选为范围。desktop/host/workspace-main.ts 区分本机只读与认证服务读取，renderer/export-scope.tsx 明确确认当前来源，切换来源清除旧确认。server/composition/workspace-mcp.ts 的所有者范围接口不在 MCP 工具目录内，领域管理授权不能取得导出权限。tests/integration/export-scope.test.ts 及 tests/e2e/mcp-management.test.mjs 分别覆盖磁盘范围与真实桌面交互。
