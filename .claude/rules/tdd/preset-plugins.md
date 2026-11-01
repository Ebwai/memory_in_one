---
paths:
  - "packages/contracts/src/templates.ts"
  - "packages/core/src/workspace/domains.ts"
  - "apps/desktop/**/*"
  - "apps/server/composition/workspace-sync.ts"
---
# 预设模板创建插件、项目模板与随记

## 模块概览

沿现有领域注册边界实现。contracts/templates.ts 定义系统随附的声明，core 的 DomainRegistry 管理实例生命周期，desktop 的领域入口及视图承接交互，server 的 WorkspaceSync 复核共享声明与生命周期。

## API 与数据语义

项目实例身份独立于名称，项目名放在登记的 displayName 中，避免重命名改变程序摘要。随记为固定 preset.notes；项目为 preset.project.<独立身份>。模板声明与用户提供的程序区分，只有匹配系统声明的实例可自动补齐程序。

## 关键流程与状态

创建先登记再启用，重试沿原实例及操作身份接续。项目重命名通过登记 CAS 保存。整体删除设置不可逆 removed 标记并停用；目录、业务写入及权威入口共同关闭该实例。删除为逻辑删除，历史操作及恢复材料按已有数据保障机制保留，不承诺擦除历史备份。取消删除不提交。旧设备不能通过重新启用或注册恢复已删除实例。

项目内容通过 kind 区分想法与简单待办，随记只有文本记录；两者都使用原通用内容保存、冲突、同步和草稿退出门禁。时间排序使用创建时间，不随编辑改变。

## 验证

已通过 tests/integration/preset-plugins.test.ts 的 2 项测试，覆盖隔离、同名实例、重命名、删除门禁、随记身份、校验、磁盘重启及真实 HTTP 同步；tests/e2e/preset-plugins.test.mjs 覆盖真实窗口的模板创建、内容编辑/删除、完成恢复、取消整体删除及重启。既有 137 项集成测试及 workbench 的 2 项窗口测试通过。
