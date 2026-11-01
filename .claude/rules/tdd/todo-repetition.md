---
paths:
  - "packages/todo-list/**/*"
  - "packages/contracts/src/domain-evolution.ts"
  - "apps/desktop/renderer/todo-*.tsx"
  - "apps/server/composition/workspace-*.ts"
---
# 备注、周期重复与兼容字段升级

## 模块概览

沿用共享包架构中的 todo-list 业务所有权和 core 通用提交边界。关联 PRD：待办备注、周期重复待办、领域扩展注册。

实现锚点：`todo-list/repetition.ts` 的 `repeatPeriod/currentTodo/currentTodoRows`；`progression.ts` 的领域命令；`contracts/domain-evolution.ts` 的兼容判断；`core/workspace/domains.ts` 注册；桌面详情与列表及服务 MCP 组装。

## API 概览

领域命令负责备注及重复设置、单次计数；读取投影解释当前周期。通用 JSON 存储、同步及快照不枚举待办字段，不需要数据库新增列。兼容升级只支持同数据版本的可选字段扩展，程序材料仍按设备保存。

## 数据模型

持久化任务 JSON 是事实源；当前周期状态是按任务保存的 IANA 时区与时钟派生的投影。缺少备注／重复配置的旧记录分别视为空备注／普通任务，不回填 null。具体字段和限制以 repetition.ts 和 validator 为准。

## 关键流程

读取时按自然日历投影周期与零进度，处理祖先恢复；无需后台循环写库。用户操作时在原记录序号基础上计算当前周期并提交，多记录祖先变化仍走集合事务。重试复用冻结时间与操作身份，避免重复计次。周期结束后下次读取即显示未完成，主窗口时钟检查触发更新。

## 一致性、并发与幂等

备注独立比较；完成状态、时间、重复配置和周期计数作为同一属性组比较，避免拼出非法组合。重复操作保留操作时间参与比较，来自不同时间的并发点击不因计数相同而误判相同成果；不自动相加离线分支。普通任务保留已有兼容完成策略；重复任务不使用该捷径。登记的程序声明和摘要作为同组同步，启用状态单独比较；旧客户端不认识的新字段会被旧校验拒绝，因此服务与桌面应一同更新。

MCP 查询保留原始 `value/revision` 作为编辑依据，并额外返回 `effectiveValue` 表示当前周期投影；列表及单条查询都纳入祖先恢复。MCP 的 update 权限可分别修改文字、备注或重复设置，一次修改一项。

## 异常处理与测试

不兼容声明升级拒绝；重复设置非法不提交；缺程序及冲突保留原材料。测试锚点：todo-repetition.test.ts、domains.test.ts、todo-progress.test.ts、todo-tree.test.ts 及真实窗口验收。快照携带原始字段，周期投影在恢复后继续按保存时区计算。
