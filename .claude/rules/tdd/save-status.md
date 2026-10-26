---
paths:
  - "packages/ui/**/*"
  - "apps/desktop/**/*"
  - "tests/integration/save-status.test.ts"
  - "tests/e2e/status-demo.test.mjs"
---

# 保存与同步状态呈现

状态：N03 状态投影、React 组件和 Windows 保存状态演示已实现并验收，2026-10-25；已按实际代码及测试校准。网络及冲突展示仅为接入契约与明确标注的含义预览，未实现传输或冲突处理。

## 当前改动的状态投影

### 模块概览

Architecture：[共享 UI](../architecture/packages.md)、[桌面入口](../architecture/desktop.md)。
PRD：[保存与同步状态呈现](../../../docs/prd/公共机制/统一进度保障/可靠保存与结果确认/保存与同步状态呈现/保存与同步状态呈现.md)。

| 实现锚点 | 作用 |
|---|---|
| packages/ui/src/save-status.ts | 当前动作状态、结果映射、同步证据接入与文字投影 |
| packages/ui/src/SaveStatus.tsx | 无宿主依赖的 React 状态组件及处理入口 |
| apps/desktop/host/main.ts | 演示宿主的真实本机保存、核对和重启读取 |
| apps/desktop/bridge/preload.ts | 受限方法桥接，无原始 IPC 和文件端口 |
| apps/desktop/renderer/main.tsx | 草稿保留、当前动作切换和状态显示 |
| tests/integration/save-status.test.ts | 状态竞争、回执恢复及可理解文字验证 |
| tests/e2e/status-demo.test.mjs | 真实 Electron 窗口与安全桥接验收 |

### API 概览

状态由操作身份和本机序号绑定。createSaveStatus 建立未保存状态；startLocalSave 进入保存中；applyLocalResult 消费 N01/N02 的结果；applySyncStatus 消费后续同步机制提供的当前动作证据。projectSaveStatus 只生成用户文字与可用动作，不执行持久化或网络。

同步事件携带当前完整操作引用、本机序号和单调递增的同步尝试编号。陈旧动作、不同内容、不同空间及较早尝试不能反向修改当前状态；一次尝试已确认同步后，迟到的失败或进度事件也不能使其倒退。

### 数据与状态语义

展示投影不产生保存事实，不写数据库。保存失败与本机结果待确认均保留输入；本机成功后的待同步状态可按领域规则清空已提交输入。同步失败或同步结果待确认仍承认已有本机成果。

重启时只依据已持久记录及对应回执恢复“已保存在本机，待同步”；当前没有服务器确认材料，不能还原“已同步”。读取失败独立反馈，保留已有可展示内容，不能伪装为空内容或已同步。

### 关键流程与并发

1. 用户编辑时建立当前草稿动作身份；输入仅保存在 renderer，未提交草稿不新增跨重启恢复承诺。
2. 提交冻结当时文字及动作身份，先呈现保存中，再通过窄桥接调用本机保存服务。
3. 返回结果只能作用于相同当前动作。若用户已开始新草稿，旧结果不能清空新输入或将新草稿标为已保存。
4. 明确失败沿原快照重试；不明结果沿原操作核对，不能改为新动作。
5. 本机成功显示待同步；演示不自动触发任何已同步事件。
6. 同步与冲突文案在独立“状态含义预览”区展示，与真实本机记录状态分开。

### 边界与异常

- 同步传输、冲突解决、领域注册和悬浮待办不由本节点实现。
- React 组件显示文字含义和可用处理按钮，颜色只起辅助作用。
- 演示主进程固定记录范围，校验调用窗口及 frame；renderer 无 SQL、文件路径及系统执行权限。
- 桥接拒绝或无可信结果时保留输入，不能自行报保存成功。
- 冲突入口由上层机制注入；当前演示只预览含义，不模拟已经解决真实冲突。
- 多个读取请求并发时，仅最新请求可更新内容或错误反馈；旧请求异常不能遮蔽新请求成功。该边界由 N04 窗口回归覆盖。

### 监控与测试

验证真实保存后输入清空、失败及不明结果保留、较晚结果不影响新草稿、重启恢复待同步、已同步文案不代表所有设备更新、同步失败与本机失败区分。真实窗口测试使用隐藏窗口和独立临时数据目录；不操作用户已有工作空间。

实际验证：Node.js 22.23.0 与 Electron 45.0.0 内置 Node 24.22.0 各通过 44 项（30 项既有持久化测试和 14 项状态测试）；真实 Electron 窗口测试 1 项通过，覆盖正常保存、重载、旧响应、新草稿、失败、待确认、读取失败及 renderer 权限隔离。依赖边界、类型检查及离线 frozen-lockfile 安装通过。截图由窗口测试生成至 .build/status-demo.png。

### 关键技术决策

- 采用 React 的 [createRoot](https://react.dev/reference/react-dom/client/createRoot) 渲染共享状态组件；状态投影保持为独立纯函数，便于检验迟到结果和动作身份。
- 通过 Electron 的 [context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation) 与受限 preload 提供 save、recover、load 三项演示方法；renderer 不获得原始 IPC、文件端口或 Node 权限。
- 使用 [Playwright Electron 支持](https://playwright.dev/docs/api/class-electron) 进行真实窗口测试；测试采用离屏渲染避免弹窗，普通演示运行使用可见窗口。该框架的 Electron 支持为实验性，已用本项目锁定版本实测，不据此声称所有版本兼容。
- [esbuild](https://esbuild.github.io/api/) 将 renderer 编译为浏览器包、preload 编译为保留 electron 外部依赖的 CJS 包；宿主与数据库 worker 仍由 TypeScript 按原目录输出，不把 worker 路径嵌进浏览器包。

