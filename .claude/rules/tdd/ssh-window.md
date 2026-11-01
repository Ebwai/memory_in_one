---
paths:
  - "apps/desktop/**/*"
  - "tests/e2e/ssh-tunnel.test.mjs"
---
# SSH 与圆角窗口

## 模块概览

PRD：应用连接与悬浮外观。host/ssh-tunnel.ts 拥有配置、私钥副本、主机校验与单个子进程；renderer/ssh-settings.tsx 仅展示配置和状态，桥接只允许 status/key/save/disconnect。窗口样式由 workspace.css 与 workspace-main 的透明无框窗口协同完成。

## API 与数据

主进程校验 IPC 来源，私钥由系统文件选择器选取并复制到本机数据目录，Windows ACL 移除继承并限制当前账号读取；不经 renderer 读取。公共配置持久化，不包含所有者凭据。固定转发仅监听 127.0.0.1:43128，目标服务器回环端口 43127。

## 状态与关键流程

启动读取本机配置→以禁止私钥、密码及 agent 认证的 SSH 探测取得 ED25519 公钥（探测阶段不建立转发）→计算 SHA256 并与配置指纹相等比较→写独立 known_hosts→启动隐藏 SSH 子进程。StrictHostKeyChecking、BatchMode 和 IdentitiesOnly 启用，禁用用户 SSH config；不执行 shell 拼接。临时失败延迟重连，身份/指纹错误停止盲目重试；配置变更以代次取消旧连接，退出终止自有子进程，不处理其他应用进程。通道状态与核心同步状态分开。

## 窗口与异常

2026-11-01 C 图视觉更新：透明无框窗口采用黑白方形表面及阶梯切角，拖动区与按钮 no-drag 分离。DomainManager 的 compact 状态控制宿主 floating/management 动作，初始为完整工作台，本机 localStorage 记住窗口模式；切换时不卸载 TodoCapture，不丢失未提交内容。宿主管理模式使用 1280×820，悬浮模式沿用 440×650。TodoCapture 在宽窗口以右侧详情栏复用 TodoDetails，窄窗口仍用覆盖详情及既有焦点循环、未保存处理；列表筛选仅影响呈现，不改记录状态。共享 workspace.css 负责三栏宽度、紧凑录入和阶梯切角。关闭按钮经 request-close 回到原有领域草稿门禁。最小化和置顶由宿主执行。

## 验证

隔离子进程夹具验证命令参数、主机指纹拒绝、瞬断重连与停止；真实 Electron 检查圆角样式、配置入口和关闭保留草稿。真实公网连通性单独记录，不能把模拟工具测试作为实际远端连接成功。
