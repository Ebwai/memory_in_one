# Android 应用

构建：`pnpm build:android`，输出 `output/android/workspace-android.apk`。调试构建：`pnpm build:android-debug`，输出 `workspace-android-dev.apk`。普通构建关闭 WebView 调试与测试对象。最低声明 Android 8；目前实际设备验证为 Android 14 Pixel 7 模拟器，其他系统和真机仍待验证。

已接入代码：本机与服务器空间、SQLite 操作历史、原 SyncEngine 同步与冲突选择、待办/子树/重复规则、项目与随记、声明式插件、Keystore 凭据保护、SSH 密码/私钥及主机指纹核验、MCP 管理、原格式快照导出与隔离恢复、迁移停写/启用、APK 检查与安装。无悬浮窗。

实际通过的端到端检查：本机 SQLite 重读、本机权威同步回执、真实服务上传和确认、断线保存与重新接续、并发冲突保留和选择、MCP 授权创建撤销、本机快照捕获和隔离副本恢复；SSH 错误主机指纹拒绝和真实密码认证转发通过。测试入口 `tests/android-device.test.mjs`、`tests/android-ssh-fixture.py`、`tests/android-ssh.test.mjs`。

待完成验收：最近修正的完整权威快照恢复与迁移启用需重新跑完；系统文件选择器交付、实际 APK 升级安装、SSH 私钥认证、插件全生命周期及各 Android 版本兼容尚未完成实测。当前不能宣称已完成全部功能等价验收。

使用现有 Android SDK 35/build-tools 35.0.1、Android Studio Java、Python、Node/esbuild。原生依赖版本与校验和见 dependencies.json；SQLite 随应用打包以统一数据库能力。依赖下载只使用固定来源并校验 SHA256。签名使用 `.build/android/development.keystore`，需保留此文件以继续覆盖安装；正式分发须维护发布签名。

请勿卸载旧开发版来更新；覆盖安装保留本机数据。首次进入会将首版简化存储中的待办幂等迁入共享数据模型，原材料保留。恢复会创建新位置，旧授权不恢复效力，恢复的权威位置保持 prepared，必须明确完成停写/隔离核对后启用。

2026-11-02 补充：最新一轮 `tests/android-device.test.mjs` 已完整通过，包括权威备份恢复、旧授权不自动生效、prepared 状态及明确隔离启用门禁。先前“需重跑”的这一项已完成。系统文件选择器交付、实际升级安装、私钥认证及其他机型仍未完成实测。
