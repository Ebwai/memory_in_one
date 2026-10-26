---
paths:
  - "packages/core/src/workspace/**/*"
  - "packages/contracts/src/workspace.ts"
  - "packages/adapters/src/workspace/**/*"
  - "apps/server/**/*"
  - "apps/desktop/host/workspace-main.ts"
  - "apps/desktop/renderer/workspace.tsx"
---
# 统一位置初始化

状态：N05 已实现并验收，2026-10-25。承接已确认 Architecture。远端路径以独立回环 HTTP 服务验证，未声称已实测公网 TLS 或云部署。

## 创建、发布与本机绑定

### 模块概览

PRD：[统一位置初始化](../../../docs/prd/数据自主与迁移/存放环境管理/统一位置初始化/统一位置初始化.md)。边界：[服务](../architecture/server.md)、[核心](../architecture/core.md)、[桌面](../architecture/desktop.md)。

核心只校验名称和创建身份，生成候选空间身份，通过端口请求创建。SQLite 适配器在工作线程建立数据库；服务提供认证初始化与结果核对；桌面在创建确认后才原子保存本机绑定。领域登记不属于本节点。

### API 与数据语义

创建请求携带稳定 creationId；同目标、同 ID、同名称的重试返回原空间，不生成新身份。不同名称复用 ID 明确拒绝。spaceId 与 authorityId 均为独立身份，名称相同不构成同一空间。

创建成功只表示选定环境存在权威空间；本机绑定另行确认。本机回环服务不宣称其他设备可达。已有空间接入为 N06，恢复为后续独立路径。

### 发布流程与并发

创建先在目标目录的暂存 SQLite 中事务写入完整存储格式及空间元数据，关闭并刷新后，以不覆盖目标的硬链接发布为 workspace.sqlite。竞争发布只能有一个成功者；已存在文件只读核对，绝不重建或覆盖。

并发读取暂存材料与初始化写事务共享 SQLite 忙等待，避免短暂读锁使所有同请求竞争者都中止。另一竞争者已发布并移除暂存链接时，沿原目标重新核对身份，不因暂存路径消失而替换或重建空间。并发回归在两个运行时重复十轮验证。

创建结果丢失时查原 creationId；损坏或未完成的暂存材料保持待确认，不自动删除并重建。普通失败不修改此前本机绑定。初始化的本机输入与加密凭据先作为待处理请求留存；应用重启可沿原 ID 继续。

### 服务与权限

独立 Node 服务默认回环监听；有所有者引导密钥才接受创建及身份查询。服务启动的独占 SQLite 租约在进程终止后由操作系统释放，同一数据目录不能同时启动两个服务。无认证请求不读取空间信息。

远端配置只接受 HTTPS；明确的回环地址可使用 HTTP。请求不跟随重定向，网络超时或响应不完整保留待确认；不自动创建替代本机空间。本机服务使用相同 HTTP 边界，密钥只由宿主持有。

### 本机绑定与凭据

绑定在权威创建确认后原子写入，包含空间身份与明确位置。远端密钥使用 Electron 主进程的系统加密存储封装；不写明文进度文件、普通日志或返回给 renderer。系统加密不可用时拒绝持久化密钥，不降级为明文。

### 实现锚点

contracts/workspace.ts、core/workspace/initialization.ts、adapters/workspace/authority.ts 与 worker、apps/server/transport/server.ts、apps/server/lifecycle/lease.ts、apps/desktop/host/workspace-main.ts。完整字段与协议由实现维护。

### 验证范围

真实磁盘与 HTTP 覆盖空名称、同名不同身份、原请求重试、已存在目标保护、竞争创建、未授权、不可达远端、单实例服务及结果核对。窗口覆盖创建、失败保留输入、成功位置和重启绑定；不声称已实现 todo-list、同步或导出恢复。

实际验证：原 48 项加 N05 的 18 项，Node.js 22.23.0 与 Electron 45.0.0 内置 Node 24.22.0 各通过 66 项；两个窗口测试组共 4 项通过。另核对了已知失败重启后可修改凭据、同 ID 不能更换原目标，以及不安全返回身份不能构造客户端路径。

测试锚点：tests/integration/workspace-initialization.test.ts、tests/e2e/workspace-setup.test.mjs；截图为 .build/workspace-created.png。入口为 pnpm demo:workspace 与 pnpm start:server。

### 关键技术决定

- [Node 硬链接](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromiseslinkexistingpath-newpath) 发布完整 SQLite，目标存在不替换；Windows 刷新完整暂存文件使用可写句柄。不支持时不静默退回覆盖式 rename。
- [Electron safeStorage 异步 API](https://www.electronjs.org/docs/latest/api/safe-storage) 保护远端凭据，解密读取 result，启动重新绑定时再次加密。保护依赖系统凭据服务，不声称隔绝同一用户下的所有程序。
- [原生目录选择](https://www.electronjs.org/docs/latest/api/dialog) 或用户明确输入确定目标。renderer 仅临时承接用户输入，不从持久层回取原秘密。

