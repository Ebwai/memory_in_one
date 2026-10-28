---
paths:
  - "packages/**/*"
  - "tests/**/*"
---

# TDD 导航

2026-10-27 接续：[Ubuntu 与 Windows 服务端交付](../.claude/rules/tdd/server-deployment.md)，承接既有统一位置初始化与服务端交付，不改变领域业务规则。

Architecture 基线已于 2026-10-25 经用户确认。当前实现 N01–N70，含共享保存、领域生命周期、Windows 待办、真实同步、MCP 授权与动作，以及双来源导出、隔离恢复、统一位置迁移、Windows 便携交付和递归待办拖动组织。技术设计按节点建立并校准为实际实现。

| 当前设计 | Architecture 位置 | PRD 锚点 |
|---|---|---|
| [待办拖动与递归目标](../.claude/rules/tdd/todo-tree.md) | [核心](../.claude/rules/architecture/core.md)、[共享包](../.claude/rules/architecture/packages.md)、[桌面](../.claude/rules/architecture/desktop.md) | 待办优先顺序调整、待办归属调整、待办层级回看、父子完成约束及子树删除（N63–N70） |
| [本机保存事务与重启恢复](../.claude/rules/tdd/local-persistence.md) | [核心](../.claude/rules/architecture/core.md)、[适配器](../.claude/rules/architecture/adapters.md) | [本机内容持久保存](prd/公共机制/统一进度保障/可靠保存与结果确认/本机内容持久保存/本机内容持久保存.md) |
| [操作幂等与结果核对](../.claude/rules/tdd/local-operation-recovery.md) | [核心](../.claude/rules/architecture/core.md)、[适配器](../.claude/rules/architecture/adapters.md) | [重复提交与结果恢复](prd/公共机制/统一进度保障/可靠保存与结果确认/重复提交与结果恢复/重复提交与结果恢复.md) |
| [当前改动的状态投影](../.claude/rules/tdd/save-status.md) | [共享 UI](../.claude/rules/architecture/packages.md)、[桌面入口](../.claude/rules/architecture/desktop.md) | [保存与同步状态呈现](prd/公共机制/统一进度保障/可靠保存与结果确认/保存与同步状态呈现/保存与同步状态呈现.md) |
| [共享保存闭环整合](../.claude/rules/tdd/reliable-save.md) | [核心](../.claude/rules/architecture/core.md)、[桌面入口](../.claude/rules/architecture/desktop.md) | [可靠保存与结果确认](prd/公共机制/统一进度保障/可靠保存与结果确认/可靠保存与结果确认.md) |
| [空间创建、发布与绑定](../.claude/rules/tdd/workspace-initialization.md) | [服务](../.claude/rules/architecture/server.md)、[核心](../.claude/rules/architecture/core.md)、[桌面入口](../.claude/rules/architecture/desktop.md) | [统一位置初始化](prd/数据自主与迁移/存放环境管理/统一位置初始化/统一位置初始化.md) |
| [已有空间核验与绑定](../.claude/rules/tdd/workspace-connection.md) | [核心](../.claude/rules/architecture/core.md)、[桌面入口](../.claude/rules/architecture/desktop.md) | [已有工作空间接入](prd/数据自主与迁移/存放环境管理/已有工作空间接入/已有工作空间接入.md) |
| [领域登记与生命周期](../.claude/rules/tdd/domain-registration.md) | [核心](../.claude/rules/architecture/core.md)、[扩展](../.claude/rules/architecture/extensions.md)、[桌面](../.claude/rules/architecture/desktop.md) | 领域扩展注册、领域启用状态管理、领域程序移除、领域目录与进入（N07–N10） |
| [待办快速收录整合](../.claude/rules/tdd/todo-capture.md) | [共享包](../.claude/rules/architecture/packages.md)、[桌面](../.claude/rules/architecture/desktop.md) | 待办内容录入、Windows悬浮收录入口、待办提交与结果反馈、待办快速收录、快速收录（N11–N15） |
| [待办与内容回看](../.claude/rules/tdd/todo-review.md) | [共享包](../.claude/rules/architecture/packages.md)、[桌面](../.claude/rules/architecture/desktop.md) | 待办显示判定、待办详情查看、待办主界面回看、待办回看、内容回看（N16–N20） |
| [待办推进与原操作重试](../.claude/rules/tdd/todo-progression.md) | [核心](../.claude/rules/architecture/core.md)、[共享包](../.claude/rules/architecture/packages.md)、[桌面](../.claude/rules/architecture/desktop.md) | 待办内容修改、待办截止日期设置、待办完成状态切换、待办删除、待办推进（N21–N25） |
| [内容推进整合](../.claude/rules/tdd/content-progression.md) | [核心](../.claude/rules/architecture/core.md)、[桌面](../.claude/rules/architecture/desktop.md) | 内容推进（N26） |
| [属性合并、冲突材料与解决选择](../.claude/rules/tdd/conflicts.md) | [核心](../.claude/rules/architecture/core.md)、[适配器](../.claude/rules/architecture/adapters.md)、[桌面](../.claude/rules/architecture/desktop.md) | 待办冲突判定、并发差异判定与自动合并、冲突成果保留、冲突解决选择（N27–N30） |
| [权威同步与离线接续](../.claude/rules/tdd/replication.md) | [核心](../.claude/rules/architecture/core.md)、[适配器](../.claude/rules/architecture/adapters.md)、[服务](../.claude/rules/architecture/server.md)、[桌面](../.claude/rules/architecture/desktop.md) | 并发整合、本机改动上传、统一进度获取、删除结果传播、同步触发与刷新、跨设备进度同步、离线内容访问、离线操作受理、连接恢复接续、离线记录与补同步（N31–N43） |
| [MCP 授权、调用与来源记录](../.claude/rules/tdd/mcp.md) | [核心](../.claude/rules/architecture/core.md)、[服务](../.claude/rules/architecture/server.md)、[MCP](../.claude/rules/architecture/mcp.md)、[桌面](../.claude/rules/architecture/desktop.md) | MCP调用记录、MCP接入授权、MCP内容查询工具、MCP内容操作工具、MCP领域管理工具、MCP工具接入（N44–N49） |
| [导出范围确认](../.claude/rules/tdd/export-scope.md) | [核心](../.claude/rules/architecture/core.md)、[适配器](../.claude/rules/architecture/adapters.md)、[桌面](../.claude/rules/architecture/desktop.md) | 导出范围确认（N50） |
| [数据携带、隔离恢复与迁移](../.claude/rules/tdd/portability.md) | [核心](../.claude/rules/architecture/core.md)、[适配器](../.claude/rules/architecture/adapters.md)、[桌面](../.claude/rules/architecture/desktop.md)、[服务](../.claude/rules/architecture/server.md) | 一致快照生成、导出文件交付、恢复材料与目标校验、工作空间恢复写入、恢复结果确认与接续、统一位置迁移切换及交付整合（N51–N62） |

完整产品队列仍由 [PRD](PRD.md) 维护。N41–N43 整合沿既有同步和领域链验收；N44–N49 见 MCP 设计；N50–N53 完成来源确认、一致快照和完整文件交付，见[导出快照与交付](../.claude/rules/tdd/portability.md)；N54–N62 完成恢复、迁移、独立领域及交付包整合，沿同一设计维护。正常回环联通环境通过双桌面时效验证，未声称公网、移动端或具名外部 Agent 客户端已验收。

