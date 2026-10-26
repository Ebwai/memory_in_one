---
paths:
  - "packages/core/src/operations/**/*"
  - "apps/desktop/renderer/**/*"
---
# 内容推进

## N26 整合

状态：2026-10-26 已完成整合验收。

内容推进是领域能力映射，沿用既定 core operations 与独立领域包边界；不引入通用完成状态或任意载荷覆盖接口。当前可执行落点为待办推进，入口、原内容身份、字段动作、可靠受理及重试均复用 [待办推进](todo-progression.md)。

实现锚点为 ExistingContentService.mutate、prepareTodoMutation、TodoDetails 与 useTodoProgress。后续自定义领域仍通过已有声明动作和领域校验处理，不继承待办字段。

验收使用 tests/integration/todo-progress.test.ts 与 tests/e2e/todo-progress.test.mjs：在同一任务上改字、设置和清除日期、完成与恢复、删除，重启保持身份与成果；取消不写入，旧操作不会覆盖新版本。本节点不建立新的跨实现点状态。
