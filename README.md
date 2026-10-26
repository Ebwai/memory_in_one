# 个人信息统一工作空间

优先实现 Windows 悬浮待办，以统一工作空间承载独立信息领域，并提供同步、数据携带与外部 Agent 的 MCP 工具入口。

当前已实现至 **N70**。Windows 待办、递归子待办与拖动排序、整树移动/删除、独立领域、可靠保存、同步与冲突、MCP，以及双来源完整导出、空白目标恢复和统一位置迁移均已接入。完整回归 281 项测试通过。运行 `pnpm build:release` 生成便携包，再运行 `.build/release/workspace-windows-v0.1.0/工作空间.exe`，并保留整个便携目录。详见[使用指南](docs/使用指南.md)与[交付验收](docs/交付验收.md)。构建产物不随源码提交。

## 本地运行

已验证环境：Windows、Node.js 22.23.0、pnpm 11.25.0。Electron 固定 45.0.0，其内置 Node 24.22.0 已通过同一持久化测试集。Node 22 的内置 SQLite 仍带实验性标记，驱动封装在适配器内。

```powershell
pnpm install --frozen-lockfile
pnpm demo:persistence
pnpm demo:recovery
pnpm demo:status
pnpm demo:workspace
```

演示在系统临时目录创建独立数据库，保存一条通用笔记，关闭并重新打开，显示恢复内容和待同步操作数，最后打印数据路径。它不会修改已有工作空间。

恢复演示额外验证同一次操作并发提交只保存一份，以及继续修改后重启、核对和重试旧操作时保留较新内容。未找到原回执或无法读取时保持“尚不能确认”，不自动产生新动作。

`pnpm demo:status` 打开 Windows 演示窗口，可输入内容、保存、查看本机记录及重新读取；重启后恢复“已保存在本机，待同步”。演示数据位于 Electron 用户数据目录下独立的 `status-demo` 目录。窗口的状态含义预览不表示已连接服务器，也不执行模拟同步。

保存期间开始的新草稿不会被旧结果清空；本机保存失败和结果不明会保留输入，并提供适用的重试或核对入口。读取失败会显示明确问题，不把已保存内容伪装为空。

首次安装 Electron 需下载运行时。如官方二进制下载在当前网络失败，可在当前 PowerShell 会话配置下载镜像，再重新运行安装或测试命令；不要将凭据写进项目配置。

## N07–N15：领域管理与快速收录

运行 `pnpm demo:workspace`。新建空间后默认进入已启用的待办悬浮界面；重启已有绑定时也按已保存的启用状态进入。窗口默认置顶，支持系统标题栏拖动和置顶切换。只输入文字，通过添加按钮或 Enter 保存；Shift+Enter 换行，中文选词不误提交。多行粘贴是一条任务，不自动解析日期或完成标记。

本机可靠保存后显示“待同步”、清空文字并保持焦点。失败保留输入，结果不明先核对并沿原操作重试。输入提交期间只读；不按文字自动去重。已保存任务在退出重启后恢复，未提交草稿的崩溃恢复不在当前范围。

点击“工作空间管理”可查看领域身份、版本、空间启用状态和本机程序状态。启停不删数据；移除自定义程序只影响当前设备。离开、停用、移除或正常关闭前，草稿可保存、明确放弃或取消；未确认提交不能直接放弃。内置待办随客户端提供，不能独立移除。

可选择或粘贴 [扩展样例](extensions/sample-independent-domain/extension.json)，查看兼容信息后注册并启用；扩展只访问所属领域。重复注册不重建，相同身份的不同包拒绝覆盖；缺程序时使用原包补齐。详见 [扩展作者指南](extensions/guide/README.md)。

N14、N15 已验证快速收录整合及独立领域隔离。当前已补齐 N16–N25 的回看与本机推进；通用推进、完整冲突、真实联网同步及 MCP 工具现已完成，见下方说明；数据文件导出恢复及迁移现已通过 N51–N62 接入。

## N16–N20：回看已有内容

未完成区按创建时间从新到旧排列，无日期、未来日期和逾期任务都持续可见；截止日期只改变标签。已完成区默认折叠，显示数量，展开后按完成时间从新到旧排列。长文字在列表中截断，点击任务文字可阅读完整详情；关闭详情保留原滚动位置和已完成展开状态。

日期依据当前设备本地日历日判定，窗口持续打开、设备恢复使用或日期变化后会重新判断，不复制任务。非法日期和未知完成状态明确提示，既有内容不会因此隐藏。

列表和详情都区分加载、读取失败及实际不存在。失败保留此前可确认内容，不把失败当作空列表，也不把本机成果称为已联网同步。阅读摘录等扩展继续使用自己的字段和视图，不继承待办的完成区或日期规则。

回看读取不执行写操作；当前已通过 N21–N24 的专用动作接入文字修改、日期设置、完成切换和删除，见下方推进说明。入口仍为 `pnpm demo:workspace`，截图位于 `.build/todo-review.png`。

## N21–N25：推进同一条待办

在详情选择“编辑内容”或“设置截止日期”，修改后保存，也可取消或关闭未保存编辑。文字不能为空白；日期可设过去、今天或未来，也可清除为未设置。改文字或日期不改变任务身份、创建时间和完成状态，已完成任务也能编辑。

任务前的勾选框可完成或恢复，详情也提供相同入口。成功前保留原状态并显示处理中；恢复保留原日期，再次完成使用本次完成时间排序。同一任务结果未确认时暂不继续写入，可先返回列表处理其他任务，之后核对原操作；重开原详情仍能看到冻结输入。

删除从详情发起，确认时展示摘要并说明没有回收站或撤销删除入口。取消或保存失败保留任务；确认成功后移出列表并关闭详情。内部删除标记用于保持操作连续，不提供普通恢复入口。

任务若已被其他操作修改或删除，原版本请求会停止，不静默覆盖，也不把修改改成新增。失败保留输入，未知结果沿原操作身份核对；列表、详情和后续重启都使用同一本机成果。跨设备同步、属性合并与冲突解决已接入同一任务身份。

N25 已完成上述路径的真实数据库与窗口整合验收。运行 `pnpm demo:workspace` 即可体验。

## 创建工作空间

运行 `pnpm demo:workspace` 打开空间初始化窗口。默认名称为“我的工作空间”，默认在本机创建；可选择本机目录，或填写已准备服务器的地址与所有者凭据。创建与接入分开展示；选择“连接已有工作空间”，输入已有目录或服务器地址与凭据，核验并确认显示的名称和身份后接入。已有绑定可通过“重新核验已有空间”核对连接。

本机服务仅监听回环地址，关闭窗口后停止，重开按原身份启动并核对；不表示其他设备已经可访问。权威数据库与客户端副本分开存放。此入口不会迁移原保存演示数据，现已接入领域管理及 todo-list 本机快速收录；已接入自动同步和立即同步，离线成果沿原空间补传。

创建请求的名称与目标在一次操作中固定；失败保留输入，结果不明沿原请求核对，成功才保存本机绑定。远端凭据通过主进程的系统加密保存，不以明文写入绑定或待处理文件。

## 启动自管初始化服务

准备好服务器、项目依赖及本地持久磁盘后，可用以下 PowerShell 示例启动。凭据由 Node 随机生成，需要通过自己的秘密管理方式提供给创建端，并在服务重启时沿用。

```powershell
$env:WORKSPACE_DATA_DIRECTORY = 'D:\PersonalWorkspace'
$env:WORKSPACE_BOOTSTRAP_TOKEN = node -p "require('node:crypto').randomBytes(32).toString('hex')"
$env:WORKSPACE_PORT = '43127'
pnpm start:server
```

默认监听 127.0.0.1。远端访问由运维者提供 HTTPS 入口并反向代理到此服务；创建端仅接受公网 HTTPS，明确的回环地址可使用 HTTP。此功能不购买、部署或配置云资源。存放磁盘需支持硬链接与可靠刷新；不支持时不会降级为覆盖创建。

目前实际验证 Windows 独立 Node 服务、回环 HTTP、Electron 创建与加密绑定恢复；未声称在阿里云、Linux 或公网 TLS 部署完成实测。服务已开放认证初始化、同步与 MCP 应用协议，接入授权和所有者权限分别校验。

## 检查

```powershell
pnpm check
```

包括包依赖边界检查、TypeScript 检查、两个运行时的持久化、状态和整合测试，以及真实 Electron 窗口测试。当前检查包括全部磁盘集成测试、真实 Electron 界面测试和独立 stdio MCP 客户端测试。单独运行可用 `pnpm test`、`pnpm test:electron`、`pnpm test:status-ui`、`pnpm test:workspace-ui`、`pnpm check:boundaries`。

`test:electron` 使用 `ELECTRON_RUN_AS_NODE` 验证运行时；`test:status-ui` 使用真实 Electron 的隐藏离屏窗口验证 renderer、受限桥接、输入保留和重新读取，并生成 `.build/status-demo.png`。这些验证不代表完整安装包、公网或移动端交付。测试只操作独立临时目录，不读写演示或用户数据。

## 项目导航

- [PRD 骨架及 N01–N62 队列](docs/PRD.md)
- [Architecture 基线](docs/Architecture.md)
- [当前 JIT TDD 导航](docs/TDD.md)
- [N01 技术语义与实现锚点](.claude/rules/tdd/local-persistence.md)
- [N02 幂等与结果核对](.claude/rules/tdd/local-operation-recovery.md)
- [N03 状态投影与窗口验收](.claude/rules/tdd/save-status.md)
- [N04 共享保存闭环整合验收](.claude/rules/tdd/reliable-save.md)
- [N05 空间初始化与绑定](.claude/rules/tdd/workspace-initialization.md)
- [N06 已有空间核验与绑定](.claude/rules/tdd/workspace-connection.md)
- [N07–N10 领域登记、启停、程序移除与目录](.claude/rules/tdd/domain-registration.md)
- [N11–N15 Windows 待办快速收录](.claude/rules/tdd/todo-capture.md)
- [N16–N20 待办与内容回看](.claude/rules/tdd/todo-review.md)
- [N21–N25 待办本机推进](.claude/rules/tdd/todo-progression.md)
- [自定义扩展样例和指南](extensions/guide/README.md)

`packages/contracts` 定义跨实现点契约；`packages/core` 编排保存、同步、授权及来源范围；`packages/adapters` 实现 SQLite worker；`packages/ui` 提供状态投影与 React 组件；`apps/desktop` 组装演示宿主和界面。后续应用及领域按 PRD 队列逐项加入，目录和职责以 Architecture 为准。

## N26–N43：冲突、同步与离线接续

桌面保存先确认本机结果，再自动上传；常驻客户端定期获取统一进度，也可立即同步。已保存的待同步成果与原请求保留到重启，网络恢复后只补同步至原绑定空间。独立字段可自动合并，同属性差异、删除与编辑相遇时保留材料并由用户处理；结果不明先核对原操作，不能重复新增或强行覆盖。

双桌面真实客户端在正常回环环境下通过 30 秒获取目标验收；不等于公网、挂起或移动端保证。详情见 [同步设计](.claude/rules/tdd/replication.md)。

## N44–N49：接入外部 MCP 客户端

在待办点击“工作空间管理”，打开“MCP 接入管理”，填写接入名称、选择领域和动作；默认只读，写入及领域管理逐项明确授予。创建后 credential 仅此次显示，保存到外部客户端配置后可隐藏；可查看调用和授权记录，也可随时撤销。所有者凭据不会交给 MCP 进程。

配置外部客户端启动 Node，并运行本项目绝对路径下的 `apps/mcp/protocol/main.mjs`。环境变量 `WORKSPACE_MCP_URL` 为界面显示的服务地址，`WORKSPACE_MCP_TOKEN` 为该具名授权的 credential。示例结构如下，替换为实际路径、地址与凭据：

```json
{
  "mcpServers": {
    "workspace": {
      "command": "node",
      "args": ["F:/claude_project/Todo-List-in1/apps/mcp/protocol/main.mjs"],
      "env": {
        "WORKSPACE_MCP_URL": "http://127.0.0.1:43127",
        "WORKSPACE_MCP_TOKEN": "填写具名授权的 credential"
      }
    }
  }
}
```

本机托管服务随桌面关闭而停止，重开后以界面显示的当前地址为准。远端使用 HTTPS；公网明文 HTTP、URL 内凭据和跳转均拒绝。也可在已配置环境变量的开发终端运行 `pnpm start:mcp`。

工具目录随授权、启用状态及领域声明变化。`content_list/get` 返回统一位置已确认的原内容与版本；`content_create/update/date/complete/restore/delete` 只显示获授权且领域提供的动作；自定义内容使用 payload，待办使用 text。写入需稳定 operationId，修改需原 recordId 和 revision；同次重试保持这些参数。`call_status` 核对当前来源调用结果。`domain_directory/register/enable/disable/install/remove` 需要独立管理授权；程序动作当前只支持 server 目标，不能操作另一台桌面。内置待办不单独移除。

删除通过客户端 elicitation 承接具体对象确认。客户端不支持时返回所有者认证确认页面；通过后在原客户端重试原动作，变化后的对象不能沿旧确认删除。不接受工具参数中的“已确认”。官方 SDK 固定 1.32.2，实际测试的是独立 SDK 客户端进程，未声称已逐一实测 Codex、Claude Code 或语音客户端。单独验证：`pnpm test:mcp`。

## N50：确认导出来源范围

工作空间管理中的“工作空间数据导出”可选择统一位置或本机可恢复数据。预览显示空间身份、来源、该来源持有的全部领域和待同步／待核对／冲突状态，包括停用与未知领域。本机预览可离线；统一位置不可达明确报错，不会自动切换来源。

普通未提交输入先在原领域保存；已可靠保存的冲突整理材料属于可恢复范围。统一位置不声称包含其他设备未上传成果，本机不声称为统一位置最新全量。来源地址仅作说明，恢复后的凭据和写入目标须重新验证。

确认范围后选择“生成快照并保存文件”，恢复入口提供材料及空白目标预览，迁移入口提供旧位置停写与明确切换。已完整实现 N51–N62；详见[使用指南](docs/使用指南.md)。设计见 [导出范围](.claude/rules/tdd/export-scope.md)，桌面验收截图 `.build/mcp-export-scope.png`。
