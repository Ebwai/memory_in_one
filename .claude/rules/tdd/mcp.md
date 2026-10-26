---
paths:
  - "packages/core/src/access/**/*"
  - "packages/contracts/src/mcp.ts"
  - "packages/adapters/src/sqlite/**/*"
  - "apps/server/**/*"
  - "apps/mcp/**/*"
---
# MCP 接入（N44–N49，As-built）

## 模块概览
承接核心 access/operations、SQLite 事务端口、server 组装与 transport、mcp stdio 边界。已完成 MCP调用记录、MCP接入授权、MCP内容查询工具、MCP内容操作工具、MCP领域管理工具及 MCP工具接入整合。调用记录先建立，不要求先有 Agent 写入。

## API 概览
调用记录使用空间和原操作身份核对；摘要仅保留来源、领域、动作、对象、时间和确认状态。查询不能执行历史动作。后续授权及写入节点复用此记录，不另建日志数据库。

## 数据模型与一致性
工作空间 SQLite 拥有调用记录。记录可处于等待确认、结果待核对、失败、冲突或成功。成功内容事实、幂等回执和来源记录必须同事务提交；记录落盘失败则整个提交回滚。重试沿原身份读取已有结果，禁止生成第二次成功。

## 异常与测试
覆盖磁盘失败、重开、重复身份、删除后对象摘要保留；普通调用记录不携带凭据、完整对话或模型推理。

## MCP接入授权（N45）
具名授权由所有者认证管理入口创建；明文秘密只在首次交付中返回，存储仅保留散列。范围以领域及动作白名单表示，未显式指定时仅 read。授权创建、撤销和对应记录同事务；内容提交事务再次校验授权仍有效及具体动作在范围内，避免检查后撤销的竞争。授权定义与秘密分离，携带定义不能恢复凭据效力。原结果可由所有者核对，撤销后外部来源不能继续执行。

## 查询与内容操作（N46–N47）
查询使用权威历史最新版本，返回空间、领域、原内容身份和版本；不读取桌面投影。写入沿原来源及调用 ID 冻结完整请求，重试不重算时间、身份或载荷。todo-list 复用 prepareTodo/prepareTodoMutation，声明式领域复用已有校验。业务动作交给 AuthorityService，沿共同进度比较与事务门禁提交。来源只能查询自身调用结果。

删除准备先持久化待确认请求及对象摘要，独立确认通道绑定挑战、原动作和版本。普通工具参数不接受 confirmed=true。stdio 入口在协商支持 elicitation 后使用客户端交互回应；不支持时返回所有者认证管理页。确认时及执行时检查版本，变化后不凭旧确认删除；取消不写内容。该边界信任已授权接入客户端正确承接交互，不声称能证明客户端背后一定是人。

## 领域管理（N48）
目录包含授权范围内停用登记与服务器程序状态。注册和启停复用共享 prepareDomainRegistration/prepareDomainEnabled，工作空间变更通过同一 AuthorityService 写入登记版本，原数据不删。声明式程序由服务器现有通用解释器承接，程序移除/补齐控制本服务器是否开放该领域处理，不触及任何桌面程序。补齐必须提供与原登记完全兼容的声明，内置待办不可单独移除。主机可用性和来源记录在服务器 SQLite 同事务变更，且不随统一进度复制；无桌面管理通道时返回不可用。

## 持久化与原请求恢复
SQLite v5 事务升级 v1–v4，追加授权、调用记录、冻结请求和服务器程序可用性。旧数据和 pending 材料不重写；普通桌面同步不能注入 MCP 来源。成功事实、回执、来源记录同事务，授权及服务器程序状态在提交时复核。冻结请求已失败或冲突时返回原明确结果，不重复执行；失去回执时用原身份取回已有回执。历史授权定义可携带，但散列和明文凭据均不属于可恢复授权材料，后续归档实现须遵循。

## stdio 与确认兼容性
锁定官方 @modelcontextprotocol/sdk 1.32.2 维护版本，当前协商范围为其支持的 2025-11-25 协议，未宣称 2026-07-28 兼容。stdout 仅 MCP 消息；工具目录逐次根据授权、启用和声明动作生成，作用域和输入要求由 tools/catalog.mjs 维护。原调用操作身份由工具参数明确提供，重试固定。凭据通过环境变量提供，不写日志或普通列表。支持 elicitation form 时在原工具调用中请求客户端承接确认；否则返回 /manage 所有者认证页面，不接受普通工具参数自证确认。

## 实现锚点与验证
- contracts/mcp.ts、core/access/{grants,queries,operations}.ts：授权、原请求及执行语义。
- adapters/sqlite/{schema,mcp-database,replication-database}.ts：v5 迁移、事务及提交门禁。
- server/composition/workspace-mcp.ts、transport/{server,management-page}.ts：组装、认证与兼容确认页。
- apps/mcp/{protocol,connections,tools,confirmation}：官方 SDK stdio 桥接；不导入其他 app 的内部实现。
- desktop/renderer/mcp-manager.tsx 与受限 IPC：具名授权创建、撤销、来源记录和一次性凭据交付，所有者凭据留在主进程。
- tests/integration/mcp.test.ts：事务失败、迁移、撤销竞争、权威查询、内容动作、过期确认、领域管理。
- tests/e2e/mcp.test.mjs：真实外部 SDK Client 与独立 stdio Server 进程，含桌面副本接续、人工并发、elicitation 和兼容路径。
- tests/e2e/mcp-management.test.mjs：真实桌面授权管理与范围确认界面。

当前验收是实际 SDK 客户端进程，不是具名 Codex 或 Claude Code 客户端，也不验证外部客户端语音输入。官方选型依据：[SDK v1 能力](https://ts.sdk.modelcontextprotocol.io/capabilities)、[官方 SDK 发行包](https://www.npmjs.com/package/@modelcontextprotocol/sdk)。
