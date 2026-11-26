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

## 自动化授权与本机凭据（2026-11-08）

领域白名单支持 `*`，覆盖未来登记；core 校验、SQLite 提交复核、目录与工具发现共同识别。工具注册参数在该范围不限定 ID 枚举。`delete-unattended` 为独立动作，仅新建完全访问授权显式授予，删除冻结请求标记 accepted，保留版本复核、幂等和撤销事务门禁。受限授权保持原确认流程。

桌面主进程在用户数据目录 mcp-credentials.json 加密保存新凭据，按 workspaceId 与 authorityId 隔离，再按 grantId 索引；不进入同步或导出材料。列表经受限 IPC 取回供显示、复制；加密失败仍交付首次凭据并明确提示，不伪报创建失败。服务器仍仅保存哈希。旧授权无法还原，旧客户端或 Android 创建的凭据不自动进入本机保管。“复制 Codex 配置”由主进程生成真实服务地址、凭据、当前可执行文件及 MCP 脚本路径，以 ELECTRON_RUN_AS_NODE 复用随包运行时。

桌面管理、范围导出及迁移请求在拼接接口前移除 endpoint 的尾斜杠，避免远程绑定的 URL.href 产生双斜杠路径。远程启动等待内置 SSH 完成短暂连接后再核验身份，超时仍保留离线绑定。WORKSPACE_CLIENT_DIRECTORY 指定隔离客户端时，Chromium userData 也移入该目录，避免测试与日常安装共享系统加密配置。

## 工作空间备份恢复与迁移工具

server/composition/workspace-portability.ts 按授权及稳定 operationId 在服务数据目录 mcp-artifacts 下隔离备份、恢复目录、请求指纹与原子结果回执；工具参数不接受任意文件路径。仅全领域且独立授予 backup/recovery/migration 才能调用，每次请求重新认证，旧授权不扩权。备份返回标准 archive 文本和服务器路径；恢复仅接收同一空间 authority 来源，调用既有 recoverArchive，永不覆盖原目录。迁移使用 authorityControl：原位置先 stop，停写后的备份恢复为 prepared，再 activate 恢复目标；服务数据目录切换仍属于部署操作，并在目标重新授权。未提供任意主机 SSH 或系统配置修改工具。

同一 operationId 绑定请求哈希；结果回执前使用独占锁防止并发，已有回执原样返回；异常或中断使用原身份核对，遗留执行锁返回 unconfirmed，不宣称自动重放。call_status 可查询备份恢复结果；管理调用列表合并持久化回执摘要，不向列表暴露 archive 正文。备份、恢复及生命周期沿既有适配器执行，不改变内容提交事务；这些服务侧交付文件不属于空间快照，不随备份携带，标准备份文件可独立导出保存。

验证：tests/integration/mcp.test.ts 覆盖范围拒绝、备份秘密排除、幂等、请求身份复用拒绝、路径逃逸拒绝、独立恢复和先停写后激活；tests/e2e/mcp.test.mjs 使用真实 SDK stdio 验证自动注册未来领域、发现新增内容工具、无交互删除和备份恢复路由；tests/e2e/mcp-automation.test.mjs 验证本机密文、重启显示与复制、生成 Codex 配置和撤销。

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


## v1.3.5 多空间接入及内容 CRUD

desktop/host/mcp-codex.ts 提供只监听回环地址的带随机凭据桥接。描述文件在本机原子更新，stdio MCP 每次请求读取当前地址，使桌面应用重启后客户端能够接续。桥接从原 spaces.json 动态发现空间，按空间核验身份、创建全功能具名授权并加密保存在原凭据仓库。撤销授权会阻断访问，用户重新点击一键开启后可重新授权。

Codex 配置通过其 mcp add 命令写入用户目录，保留其他设置。配置只包含本机描述文件路径和启动参数，实际空间凭据仍由桌面宿主管理。应用退出时关闭桥接。

apps/mcp/tools/content.mjs 整理待办和随记各四个工具。查询通过共享 filterTodoTree 完成时间、状态、关键字及祖先路径筛选，返回属性投影始终保留 recordId/revision。待办字段修改在服务端原集合快照中按 mode 转成 prepareTodoTree 的命令，共同提交涉及的祖先修改。新增、更新及其重试使用原调用幂等与审计链路；随记创建时间由服务端产生。
