---
paths:
  - "packages/core/src/workspace/**/*"
  - "packages/adapters/src/workspace/http-location.ts"
  - "apps/desktop/**/*"
  - "tests/e2e/workspace-setup.test.mjs"
---
# 已有工作空间接入

状态：N06 接入与绑定已实现，2026-10-25；后续同步及迁移整合仍按 PRD 队列推进。

## 身份核对与确认绑定

### 模块概览

关联 PRD：[已有工作空间接入](../../../docs/prd/数据自主与迁移/存放环境管理/已有工作空间接入/已有工作空间接入.md)。Architecture：[核心](../architecture/core.md)、[桌面](../architecture/desktop.md)。复用 N05 的认证身份查询、凭据加密和原子绑定文件。

### API 与数据语义

核验只查询既有身份，不调用初始化。核心比较 workspaceId 与 authorityId；名称不能用于匹配。主进程保留待确认目标与随机确认票据，只向界面返回身份、位置和票据；界面不能在确认时替换目标、身份或凭据。

### 关键流程

输入位置与凭据 → 主进程核验 → 显示身份与名称 → 用户确认票据 → 再次查询同一目标身份 → 建立或复用该空间本机副本 → 原子保存绑定。核验、确认及创建共享互斥边界。新核验使旧票据失效，失败不修改原绑定或创建材料。

本机接入只读取已有 owner key，要求 workspace.sqlite 已存在，不使用自动生成密钥的创建路径。重启恢复已绑定空间时亦不补建缺失权威材料。

### 异常与恢复

无空间、身份不符、凭据失败、地址错误或不可达均停止接入；不创建替代空间。确认前身份发生变化时拒绝。启动无法核验时仍显示原绑定和本机副本位置，可重新核验原空间；内容获取、离线编辑及同步反馈在相应后续节点接入，不把取得绑定描述为同步完成。更换 authorityId 的迁移仍需后续迁移节点。

### 实现锚点与验证

验证结果：包依赖边界、类型检查、Node 22.23.0 与 Electron 45 内置 Node 的测试各 68 项通过，两个窗口测试组共 6 项通过。新增覆盖远端新设备接入、核验前不绑定、失败时副本字节保持、离线重启、缺失本机目标不创建，以及确认时重新比较身份。界面截图位于 .build/workspace-connected.png。

核心 workspace/connection.ts；适配器 workspace/http-location.ts；桌面 host/workspace-main.ts、bridge/workspace-contracts.ts 与 renderer/workspace.tsx；窗口验收 tests/e2e/workspace-setup.test.mjs。验证新设备接入、二次确认、同名异身份拒绝、失败保留绑定与副本、离线重启及缺失本机目标不重建。
