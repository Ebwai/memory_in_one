---
paths:
  - "apps/android/**/*"
---
# Android 持久化、同步和恢复

## Android 客户端
### 模块概览
架构见 ../architecture/android.md。实现锚点：web/client.ts、replica-store.ts、sqlite-platform.ts、local-authority.ts、native/com/workspace/mobile/Platform.java。复用原本机保存、重复提交、SyncEngine、冲突和快照概念。
### API 与数据模型
SQLite 平台桥接适配原 LocalDatabase 的 exec/prepare/iterate 和事务状态。AndroidStore 复用原存储操作契约。本机权威与副本独立；网络和 SSH 经异步 RPC 返回。空间目录与程序可用性按空间隔离。首版简化容器只保留为幂等迁移来源。
### 关键流程与状态
本机写入先取得原持久化回执，再同步；同步重用冻结请求、确认回执、原游标和冲突材料。远程身份重新核验后绑定。编辑使用基准序列，字段修改形成整体批次；输入草稿独立保存。
### 恢复与迁移
快照 envelope 沿用原格式与 SHA256。恢复分配新数据库，检查白名单表/字段、空间归属、外键和操作材料。权威快照恢复为独立权威数据库与副本，保存原身份和恢复来源，权威为 prepared；activate 沿用原停写/隔离门禁。授权只保留定义，不恢复有效凭据。
### 异常处理与验证
事务状态必须跟随成功的 BEGIN/COMMIT/ROLLBACK，失败不能显示保存成功。RPC 错误保留原操作。设备测试覆盖实际 SQLite、原 HTTP 服务、离线接续、冲突和 MCP。最新实测范围及未通过/未完成项见 apps/android/README.md，不以代码接入代替完整验收。

## 条目详情与待办树

`web/record-editor.tsx` 持有卡片编辑值，通过原始内容判定是否有未保存修改。先按输入顺序提交本机草稿保护，再执行保存或放弃。卡片打开时由卡片消费宿主的 `android:back`，条目以本机保存成功为关闭条件。待办字段和位置由 `web/client.ts` 在同一集合变更中提交。`web/client-ui.tsx` 用共享待办树的层级和父节点计算缩进与折叠后的可见子树。

### 通用待办筛选、前置关联和连接拓扑

Android 与桌面复用待办树筛选和前置关联校验。筛选期间显示命中项及其祖先，关闭后恢复原折叠状态。服务器页查询已接入空间的设备快照，设备活动仍由原有同步拉取上报。设备标识持久化在 Android 应用私有首选项中。
