---
paths:
  - "packages/contracts/src/conflicts.ts"
  - "packages/core/src/records/**/*"
  - "packages/todo-list/src/conflicts.ts"
  - "packages/adapters/src/sqlite/**/*"
  - "apps/desktop/**/*"
  - "tests/**/*conflict*"
---
# 并发差异判定与冲突接续（N27–N30）

状态：2026-10-26 已实现并通过原子节点验收。N31 已完成整体机制整合；N32–N40 已接入真实权威上传、获取与离线接续，见 [同步接续](replication.md)。

## 模块概览

沿用 Architecture core 的 records/operations 所有权和 adapters/sqlite 事务边界。关联 PRD：待办冲突判定、并发差异判定与自动合并、冲突成果保留、冲突解决选择。todo-list 注入属性含义，共享核心不依赖待办包。

实现锚点：contracts/conflicts.ts、todo-list/conflicts.ts、core/records/merge.ts、core/records/conflict-service.ts、adapters/sqlite/database.ts、desktop/renderer/conflict-panel.tsx。

## API 概览

compareContent 只返回安全合并结果或保守冲突原因，不直接保存。Comparison 绑定一个空间、领域、内容；比较输入由可信同步生产者按该身份组织，普通 renderer 不可注入统一位置版本。共同进度必须与本机分支依据一致，统一位置版本单调；changed 属性由操作历史提供，以保留完成后又恢复等最终值相同的实际修改。

ConflictService 负责保留材料、保存整理/明确提交选择，以及通过注入的权威端口确认。ConflictPersistence 是 SQLite worker 的持久化端口；领域校验由调用宿主注入。N32–N40 的传送链已通过该端口接入，联网选择获得权威确认后收尾，离线选择仍为待提交。

## 数据模型

RetainedConflict 与正常内容分表但同库，原内容身份不变。原本机材料、共同依据、取得过的远端版本与整理选择都持久化。generation 仅用于本机 CAS，不充当权威进度。null 表示明确删除，缺失版本表示材料不可取得。

## 关键流程

比较不能合并 → 在原内容序号仍一致时保存冲突 → 同一内容普通提交在事务内拒绝。新远端版本追加到材料，保留原本机与整理选择。冲突不创建普通记录；删除冲突仍可从独立提示列表进入。

用户保存整理或明确提交 → 领域校验 → 本机 CAS 保存选择与比较版本 → 离线保持 pending。权威端口只接收冻结的同一操作身份与预期版本；旧版本被拒后追加新材料，原整理保留。接受回执后，原内容写入与 resolved 状态在同一事务提交。丢失回执沿同一操作核对；提交结果未知期间禁止改写冻结选择。

## 一致性、并发与幂等

SQLite 写锁下检查 generation、原内容序号与 pending 门禁。普通写入不能绕过冲突门禁，包括创建路径和声明式领域接口。已存在的旧操作可返回原回执，但不重放旧载荷。解决材料保留，重复接受不重写较新内容；业务操作 ID 不得跨内容复用。首次建立冲突时本机分支必须匹配当前内容。

## 异常处理与验证

缺共同进度、缺领域声明、无效结果均保守保留。缺另一方时不能全量覆盖；不能可靠保存则停止处理，保留现有内容。测试覆盖独立字段、显式清日期、完成恢复历史、删除冲突、磁盘失败、重启、离线选择、远端再变化、CAS 竞争和失去回执后的原操作接续。后续 N31 完成整体并发机制验收，N32–N40 已通过真实联网与离线接续测试。

## As-built 衔接与验证锚点

存储格式升级至 v2：v1 在同一写锁内增量建立冲突材料表，原内容和不可变操作保留；未来格式、非本应用及缺损格式仍拒绝打开。SQLite 事务失败与提交结果未知分别映射，不把丢失回执当作未提交。解决结果在原 pending_operations 留下操作回执，已获确认版本保存在 resolved 材料中，后续上传器必须核对该确认依据，不能当作新的未确认动作重放。

ConflictPanel 按输入序列自动本机保存整理，允许暂存未完成、尚未通过领域校验的文字；明确提交时才执行完整领域校验。关闭应用和切换领域复用既有草稿保护，未可靠保存时阻止丢弃。保存结果未知冻结原操作身份；已知失败允许继续编辑。新取得的远端材料不替换当前编辑输入，重新比较须明确采用最新依据。

测试锚点：tests/integration/conflicts.test.ts、tests/e2e/conflicts.test.mjs；界面截图 .build/conflict-resolution.png。真实 SQLite 故障覆盖材料写入、整理保存及解决收尾事务；Electron 覆盖提示入口、普通写入暂停、选择、无效校验、重启、离线待确认及删除冲突。N30 初始验收使用注入端口；后续 N32–N40 已接入真实服务，实际 HTTP 覆盖冲突选择、原身份恢复、幂等与版本核对。离线夹具仍保持服务不可达，以独立验证暂存语义。
