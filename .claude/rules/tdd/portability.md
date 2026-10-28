---
paths:
  - "packages/contracts/src/snapshot.ts"
  - "packages/adapters/src/sqlite/snapshot-database.ts"
  - "packages/adapters/src/archive/**/*"
  - "tests/integration/snapshot.test.ts"
---
# 数据携带、恢复与统一位置迁移（N51–N62）

## 模块概览
承接 core portability 和 adapters sqlite/archive 边界；关联 PRD 一致快照生成。SqliteLocalStore.snapshot 经既有专用 worker 调用 captureSnapshot，一次只读取指定空间和来源。具体契约以 contracts/snapshot.ts 为准。

## API 概览
snapshot 输入空间身份与显式来源，返回格式、存储版本、读取时点和原始数据行。未知/停用领域不需要处理器即可保留。不存在网络失败后自动替换来源的路径。宿主校验所选空间及来源身份。统一位置快照只接受所有者凭据；本机来源只读原副本，可离线执行。桌面范围确认后由系统保存对话框明确路径和替换，取消不生成文件。archive/workspace-archive.ts 以版本化 JSON 容器携带原身份、位置说明、快照和 SHA-256 校验；先独占临时文件写入、刷新、重读校验，再原子发布。无替换授权使用独占链接；明确替换使用原子更名，失败保留旧文件。tests/integration/archive.test.ts 验证损坏、失败替换、独占保存及完整交付。校验和用于检测完整性，不代表文件来源可信。

## 数据模型与一致性
SQLite 读取事务固定一致时点；内容、删除、不可变操作、发送状态、共同依据、游标和冲突材料保持原序号及引用。权威来源保存版本历史及幂等回执，本机来源保存本机材料；不拼接来源。MCP 调用和准备材料随所选来源保存，授权定义通过 grant_definitions 保留，恢复进入独立 archive_grant_definitions，只作参考，不进入有效凭据表；有效授权秘密、本机程序状态和普通未提交编辑输入排除。已保存的冲突整理保留在冲突材料中。

## 关键流程与异常
固定事务读取 → 校验数据库和关系 → 读取明确表集合及指定空间 → 检查 JSON 可读性 → 完成事务 → 返回不可随后续数据库写入改变的数据。中断、缺失接续行、损坏引用或读取失败均拒绝完整成功，回滚只读事务，不改变源空间。

## 监控与测试
tests/integration/snapshot.test.ts 验证后续写入隔离、未知领域、删除、冲突整理、跨空间隔离、普通输入及秘密排除、离线只读和缺失接续材料失败。数据库结构版本变化须显式调整快照格式及恢复兼容性。

## 恢复材料与目标校验、工作空间恢复写入（N54–N57）
archive/recovery.ts 将校验与恢复交给独立 recovery-worker。预览在内存数据库上用真实 Schema 验证字段、表集合、值、空间归属及引用，检查目标空白，不创建目标。明确恢复后再次检查，在目标内隔离文件写入同一事务；刷新并重新读取整份表集合与材料比较后，独占硬链接发布数据库。目标已有其他数据、字段不兼容、缺失接续材料或关系损坏均停止，不部分覆盖。

workspace_restore 与数据共存恢复指纹；同次重试先核对指纹及完整数据，成功结果不重复建立空间。事务中断后的空白隔离数据库可由相同指纹安全重建；未知或损坏的已提交材料不被删除。发布前再次核对目标，竞争发布依靠独占链接拒绝覆盖。

本机来源保持 replica.sqlite、原操作序号与发送状态，不具备权威身份表；只有未绑定客户端明确使用后建立离线绑定，旧位置说明不自动成为 endpoint。统一位置来源恢复 workspace.sqlite 及原身份，authority_lifecycle 为 prepared；任何同步/MCP 写入都须通过存储事务门禁。非内置程序初始不可用，原登记、启用状态与数据不因此改变；兼容材料由原领域管理路径补齐。

renderer/recovery.tsx 展示来源、时点、领域、未同步、冲突及待补齐状态。程序可用性由宿主提供的程序指纹及材料中声明的实际指纹共同核对，不由数据包声称已安装决定。tests/integration/recovery.test.ts 覆盖校验、占用竞争、同次重试、中断空白材料、领域缺失与再导出/补齐；旧快照遇到后续删除的接续由 migration.test.ts 验证。

## 统一位置迁移切换（N58–N60）
core/portability/migration.ts 拥有原空间身份和旧位置隔离确认边界。桌面 host 组装所有者认证通道，server composition 调用存储的 authorityControl。旧位置状态未知必须明确隔离确认，可达且 active 时拒绝切换。正常路径先 stop，之后导出的快照携带 stopped 状态；目标恢复后仍为 prepared，明确 activate 才为 active。stopped 原位置不可重新 activate。

authority-commit 与 MCP 写事务在提交事务内核对生命周期，避免停写与并发提交交错。停写成功意味着此前事务已完成，后续不能继续改动权威事实。只读查询与导出仍可用。激活幂等，绑定保存失败不重新开启旧端；重试核对同一目标。凭据不从归档复活。

本机包替代统一位置需显式接受覆盖边界：local-promotion 仅从已持有确认版本建立权威基础，不把 pending 操作变成新事实；原本机恢复副本保留，接入新位置后沿原操作发送。缺失未知历史不伪造；revisionFloor 保留已知游标边界并使新确认序号继续增长。历史空洞的拉取可以前进，旧快照的已确认内容不会被当成新增。

tests/integration/migration.test.ts 验证停写、待启用、正常切换、原操作接续、旧位置持续拒写、旧授权无效、本机替代边界和旧快照不复活删除；tests/e2e/portability.test.mjs 验证真实桌面的导出、恢复和切换链。

## 交付与整合（N61–N62）
独立扩展的停用、程序缺失、恢复、再导出及补齐在 recovery.test.ts 验证。scripts/build-release.mjs 生成含 Electron 运行时的 Windows 便携目录；独立 scripts/build-server-release.mjs 生成 Ubuntu/Windows Node 服务材料（2026-10-27 接续，见 server-deployment.md）；程序与持久数据分离，携带扩展样例、MCP 入口和使用指南。release.test.mjs 从交付的可执行文件直接启动、保存并重启验证，不能用开发入口代替此证据。完整检查入口为 package.json 的 check；实际数量及平台范围见 docs/交付验收.md。
