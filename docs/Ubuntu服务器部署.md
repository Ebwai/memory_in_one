# Ubuntu 与 Windows 服务端部署

服务端共用 Node.js 和 SQLite 实现。Windows 桌面客户端继续在电脑运行；Ubuntu 服务器不需要 Electron、桌面环境、源码或包管理器。

## Ubuntu：上传并安装

目标为 Ubuntu 22.04 及更新版本，提供 x86_64/arm64 的运行时选择。实际测试系统和 CPU 以本文末尾记录为准。

1. 将 `.build/release/workspace-server-ubuntu-v0.1.0.tar.gz` 和同名 `.sha256` 文件上传到阿里云服务器，例如家目录。
2. 登录 Ubuntu，在上传目录执行：

```bash
sha256sum --check workspace-server-ubuntu-v0.1.0.tar.gz.sha256
tar -xzf workspace-server-ubuntu-v0.1.0.tar.gz
cd workspace-server-ubuntu-v0.1.0
sudo apt-get update
sudo apt-get install -y ca-certificates curl xz-utils
sudo bash deploy/server/ubuntu/install.sh
```

安装器验证文件与 Ubuntu 环境，使用已有兼容 Node，或从 Node 官方站下载并校验固定的 Node 22.23.4。下载需要服务器能够访问 nodejs.org。若已有 Node 22.23+ 或 24.22+，可指定其绝对路径：

```bash
sudo env WORKSPACE_NODE_BINARY=/usr/bin/node bash deploy/server/ubuntu/install.sh
```

不会通过管道执行远程安装脚本，也不替换系统自带 Node。网络失败时停止安装，不重置数据。包内的 Node 校验针对官方 HTTPS 发布清单；本包 SHA256SUMS 用于检查传输损坏，不代表发行者签名。

安装后的固定位置：

| 位置 | 内容 |
|---|---|
| `/opt/personal-workspace/releases/` | 版本化程序文件 |
| `/opt/personal-workspace/current` | 当前程序链接 |
| `/opt/personal-workspace/runtime/` | 需要自动下载时的私有 Node 运行时 |
| `/etc/personal-workspace/server.env` | 固定所有者凭据、端口和数据位置，仅 root 可读 |
| `/var/lib/personal-workspace/` | 持久 SQLite 数据，独立账号拥有 |

安装不新建业务工作空间、不覆盖已有数据库；首次由桌面客户端创建空间，或先按恢复/迁移规则准备目标。重复执行安装保留原配置及凭据。

## 服务管理和接入凭据

```bash
sudo systemctl status personal-workspace --no-pager
sudo journalctl -u personal-workspace -n 80 --no-pager
sudo systemctl restart personal-workspace
sudo systemctl stop personal-workspace
```

安装器自动启用开机启动和异常退出重启。启动后使用已配置凭据进行只读就绪检查，失败不会显示服务已正常就绪。

在你自己的终端读取客户端需要的所有者凭据：

```bash
sudo grep '^WORKSPACE_BOOTSTRAP_TOKEN=' /etc/personal-workspace/server.env
```

将等号后的值填入桌面客户端；不要将所有者凭据当作外部 Agent 的 MCP 凭据。凭据保持固定，重启或程序更新不重新生成。

## 阿里云 HTTPS 入口

服务默认监听 `127.0.0.1:43127`，不向公网直接开放业务端口。给服务器配置域名和 HTTPS，再代理到本机端口。

包中 `deploy/server/ubuntu/Caddyfile.example` 提供示例：

```caddyfile
todo.example.com {
    reverse_proxy 127.0.0.1:43127
}
```

替换成你的域名并合并到已有 Caddy 配置；安装器不会覆盖现有 Caddy、Nginx 或宝塔设置。若已有反向代理，配置等价的 HTTPS 转发即可，保留请求 Authorization 头及原路径。

域名 A 记录指向公网 IPv4；只有服务器具备可用 IPv6 时才设置 AAAA。阿里云 ECS 安全组或轻量服务器防火墙，以及 Ubuntu 本机启用的防火墙，需要允许所选 HTTPS 方案的 80/443 入站；内部 43127 无需公网开放。中国内地服务器的域名公网服务还需按阿里云要求确认备案条件。

官方参考：[Caddy HTTPS 代理](https://caddyserver.com/docs/quick-starts/reverse-proxy)、[阿里云安全组](https://www.alibabacloud.com/help/en/ecs/user-guide/add-a-security-group-rule)、[Node 发布目录](https://nodejs.org/download/release/v22.23.4/)。

在电脑端创建或连接空间，地址填写 `https://你的域名`，凭据填写 server.env 内的固定值。当前客户端拒绝公网明文 HTTP。

## 更新、恢复和迁移

更新程序：上传并解压新包，再执行新包中的安装器。程序校验与运行时准备完成后才停止旧服务、切换 current 并启动；原程序目录、配置和数据保留。启动失败时通过 journalctl 核对，旧版本目录不会被删除。涉及数据格式变化时，不能仅切回旧程序就声称兼容；更新前使用应用的完整导出功能保留可恢复材料。

恢复统一位置材料：在目标业务空间尚未初始化时，先停止服务，以服务账号写入目标数据目录：

```bash
sudo systemctl stop personal-workspace
# 将导出包放到 personal-workspace 账号可读的位置，示例为数据目录内的 incoming 子目录。
sudo -u personal-workspace /opt/personal-workspace/runtime/bin/node \
  /opt/personal-workspace/current/scripts/archive-cli.mjs preview \
  /var/lib/personal-workspace/incoming/snapshot.workspace.json /var/lib/personal-workspace/restored
sudo -u personal-workspace /opt/personal-workspace/runtime/bin/node \
  /opt/personal-workspace/current/scripts/archive-cli.mjs restore \
  /var/lib/personal-workspace/incoming/snapshot.workspace.json /var/lib/personal-workspace/restored
```

如果复用系统 Node，替换上述运行时路径。恢复到空白 `restored` 子目录后，修改 server.env 的 WORKSPACE_DATA_DIRECTORY 为该目录（不要更换凭据），再启动服务。该目录位于现有 StateDirectory 内，不需额外放宽 systemd 写入范围。恢复结果为待启用目标，仍需桌面明确迁移切换；旧位置先停写，不能因恢复完成就同时启用两处。来源、未知离线成果及本机包替代的规则见使用指南。

## Windows 服务端仍可使用

保留 `.build/release/workspace-server-windows-v0.1.0`；旧的 `.build/release/workspace-server-v0.1.0` 通用路径也继续提供。

在 PowerShell 中设置固定配置，再启动 Windows 入口：

```powershell
$env:WORKSPACE_DATA_DIRECTORY = 'D:\PersonalWorkspace'
$env:WORKSPACE_BOOTSTRAP_TOKEN = '你已生成并保存的固定随机凭据，至少32字符'
$env:WORKSPACE_PORT = '43127'
.\deploy\server\windows\start-server.cmd
```

需要 Node.js 22.23+ 或 24.22+，无需 Electron；Windows 桌面包附带的内置运行时启动方式也保留。Ubuntu 与 Windows 服务端使用相同协议和可携带材料，迁移仍需先停写再恢复并明确切换。

## 验证范围

开发验证使用本机 WSL 中的 Ubuntu 22.04 x86_64，运行独立 Linux Node 和解压后的服务包。systemd unit 采用静态验证；本机 WSL 的 PID 1 不是 systemd，因此没有把此测试描述成阿里云系统服务开机实测。实际阿里云域名、安全组、HTTPS 及云主机重启需要在你的服务器完成配置后核验。arm64 下载路径已提供，未宣称已在 arm64 硬件运行。
