---
paths:
  - "deploy/server/**/*"
  - "scripts/build-server-release.mjs"
  - "tests/e2e/server-deployment.test.mjs"
---
# Ubuntu 与 Windows 服务端交付

## 模块概览
关联统一位置初始化、已有工作空间接入与统一位置迁移切换，承接 delivery/server 与 apps/server 的现有边界。服务核心继续共用 Node、SQLite worker 和相同协议；Ubuntu 适配落在独立打包、运行时检查和进程托管，不复制业务实现。

## 契约与数据所有权
独立服务包从已构建的 server 和必需共享包生成，不从 Electron 目录反向复制。旧通用服务包路径保留，同时交付 Ubuntu 与 Windows 启动材料。发行清单描述版本和运行时要求，SHA256SUMS 覆盖程序文件；包内不含凭据、真实绑定及数据库。

Ubuntu 安装到版本化只读程序目录，独立系统账号运行。配置与持久数据分别由 /etc/personal-workspace 与 /var/lib/personal-workspace 持有；首次生成固定凭据，重复安装保留原配置及数据，不新建/覆盖工作空间。安装不自动调整阿里云安全组、域名或已存在的 HTTPS 配置。目标服务器由用户执行安装，当前开发验证仅使用隔离 Ubuntu 测试目录。

## 生命周期与失败边界
安装前校验 Ubuntu、系统运行环境、包完整性及 Node SQLite 能力；程序完整准备后才更新 current 链接和 systemd unit。准备失败不停止旧服务。更新时先停止现有进程，避免运行中的 worker 跨版本加载，再原子切换路径并启动；启动失败明确返回，保留旧发行目录与数据供回退。服务 SIGTERM 沿现有生命周期关闭，数据目录租约阻止第二实例。

systemd 从受保护配置文件注入固定凭据，默认仅监听回环端口；StateDirectory 持久化，Restart=on-failure 接续异常退出。Windows 保留独立 Node 启动和恢复脚本，桌面内置运行时入口保持原状。

## 验证
验证已解压 Ubuntu 包在真实 Linux Node 下的启动、鉴权、初始化、同步写入、重启身份与进度保留、导出恢复和第二实例拒绝；Windows 的既有服务/MCP 交付验收继续执行。systemd 配置静态验证与实际 PID1 托管测试区分记录，WSL 未运行 systemd 时不宣称已通过云端开机托管验收。具体结果写入部署指南及交付验收。
