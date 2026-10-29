import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile, unlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:net";

export interface TunnelConfig { host: string; user: string; port: number; fingerprint: string; enabled: boolean }
export interface TunnelScreen { config: TunnelConfig; phase: string; message: string; hasKey: boolean }
const defaults: TunnelConfig = { host: "47.112.194.71", user: "root", port: 22, fingerprint: "SHA256:iGe0xv9JN0Fi8hxvupdg10h22j00pfOu+skxep56ybQ", enabled: false };
export function validateTunnel(value: TunnelConfig): TunnelConfig {
  if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(value.host) || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(value.user) ||
      !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(value.fingerprint) || typeof value.enabled !== "boolean") throw new Error("请填写有效的服务器、SSH 端口、用户名与 SHA256 主机指纹。");
  return { host: value.host, user: value.user, port: value.port, fingerprint: value.fingerprint, enabled: value.enabled };
}
async function command(program: string, args: string[], authenticationProbe = false): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(program, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", data => { output = (output + data).slice(0, 16000); });
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => { child.kill(); fail(new Error("SSH 工具执行超时。")); }, 15000);
    child.once("error", () => { clearTimeout(timer); fail(new Error("未找到 Windows OpenSSH 客户端，请安装后重试。")); });
    child.once("exit", code => { clearTimeout(timer); code === 0 || authenticationProbe && code === 255 ? done(output) : fail(new Error("SSH 校验失败，请检查服务器、私钥及文件权限。")); });
  });
}
export class SshTunnel {
  private config = defaults;
  private child: ChildProcess | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private hasKey = false;
  private phase = "disconnected";
  private message = "配置后由应用自动连接，无需打开 PowerShell。";
  private working = false;
  constructor(private directory: string) {}
  status(): TunnelScreen { return { config: this.config, phase: this.phase, message: this.message, hasKey: this.hasKey }; }
  async load(): Promise<void> {
    try { this.config = validateTunnel(JSON.parse(await readFile(join(this.directory, "config.json"), "utf8"))); } catch { /* First use is disabled. */ }
    try { await readFile(join(this.directory, "identity")); this.hasKey = true; } catch { /* No key configured. */ }
    if (this.config.enabled && this.hasKey) void this.start();
  }
  async chooseKey(source: string): Promise<void> {
    if (this.child || this.working) throw new Error("请先断开通道再更换私钥。");
    await mkdir(this.directory, { recursive: true });
    const key = join(this.directory, "identity");
    const stagedKey = join(this.directory, "identity-new");
    await unlink(stagedKey).catch(() => {});
    await writeFile(stagedKey, "");
    if (process.platform === "win32") {
      await command("icacls.exe", [stagedKey, "/inheritance:r"]);
      await command("icacls.exe", [stagedKey, "/grant:r", `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`]);
    }
    await copyFile(source, stagedKey);
    if (process.platform === "win32") await command("icacls.exe", [stagedKey, "/grant:r", `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(R)`]);
    await unlink(key).catch(() => {});
    await rename(stagedKey, key);
    this.hasKey = true;
  }
  async save(raw: TunnelConfig): Promise<TunnelScreen> {
    const config = validateTunnel(raw);
    await this.stop(); this.config = config;
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, "config.json"), JSON.stringify(config), "utf8");
    if (config.enabled) await this.start();
    return this.status();
  }
  async stop(): Promise<void> {
    this.generation++; clearTimeout(this.timer); this.timer = undefined;
    const child = this.child; this.child = null;
    if (child && child.exitCode === null) { await new Promise<void>(done => { child.once("exit", () => done()); child.kill(); }); }
    this.phase = "disconnected"; this.message = "通道已断开，本机内容仍可离线使用。";
  }
  async start(): Promise<void> {
    if (this.child) return;
    if (this.working) { if (this.config.enabled) this.timer = setTimeout(() => { void this.start(); }, 500); return; }
    if (!this.hasKey) { this.phase = "error"; this.message = "请先选择 SSH 私钥。"; return; }
    this.working = true; const generation = this.generation;
    this.phase = "connecting"; this.message = "正在核验服务器并连接…";
    try {
      const candidate = join(this.directory, "candidate-host");
      await unlink(candidate).catch(() => {});
      // Collect the public host key without sending any private-key/password authentication.
      // This also avoids Windows ssh-keyscan KEX incompatibilities.
      await command("ssh.exe", ["-F", "none", "-T", "-p", String(this.config.port), "-o", `UserKnownHostsFile=${candidate}`,
        "-o", "StrictHostKeyChecking=accept-new", "-o", "HostKeyAlgorithms=ssh-ed25519", "-o", "PreferredAuthentications=none",
        "-o", "PubkeyAuthentication=no", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no", "-o", "IdentityAgent=none",
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", `${this.config.user}@${this.config.host}`], true);
      if (generation !== this.generation) return;
      const keyData = await readFile(candidate, "utf8");
      const fingerprint = await command("ssh-keygen.exe", ["-lf", candidate, "-E", "sha256"]);
      if (!fingerprint.split(/\s+/).includes(this.config.fingerprint)) throw new Error("服务器主机指纹不匹配，已停止连接。请向服务器管理员核对。");
      if (generation !== this.generation) return;
      const known = join(this.directory, "known_hosts"); await writeFile(known, keyData, "utf8");
      const child = spawn("ssh.exe", ["-F", "none", "-N", "-T", "-p", String(this.config.port), "-i", join(this.directory, "identity"),
        "-L", "127.0.0.1:43128:127.0.0.1:43127", "-o", "GlobalKnownHostsFile=none", "-o", "HostKeyAlgorithms=ssh-ed25519", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
        "-o", `UserKnownHostsFile=${known}`, "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", `${this.config.user}@${this.config.host}`], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      this.child = child;
      let error = ""; child.stderr?.on("data", data => { error = (error + data).slice(-3000); });
      const failed = () => {
        if (this.child !== child) return;
        this.child = null; this.phase = "error";
        const permanent = /Permission denied|bad permissions|REMOTE HOST IDENTIFICATION|Address already in use|cannot listen|bind.*Permission denied/.test(error);
        this.message = permanent ? "SSH 身份验证或本机端口失败，请检查私钥并关闭原 PowerShell 通道后重试。" : "连接已断开，正在自动重连；本机内容保留。";
        if (!permanent && generation === this.generation && this.config.enabled) this.timer = setTimeout(() => { void this.start(); }, 5000);
      };
      child.once("error", failed); child.once("exit", failed);
      setTimeout(() => {
        if (this.child !== child) return;
        const socket = connect(43128, "127.0.0.1");
        socket.once("connect", () => { socket.destroy(); if (this.child === child) { this.phase = "connected"; this.message = "SSH 通道已连接，应用可自动同步。服务地址：http://127.0.0.1:43128"; } });
        socket.once("error", () => {}); socket.setTimeout(2000, () => socket.destroy());
      }, 3000);
    } catch (error) {
      this.phase = "error"; this.message = error instanceof Error ? error.message : "SSH 连接失败。";
      if (generation === this.generation && this.config.enabled && !this.message.includes("指纹不匹配")) this.timer = setTimeout(() => { void this.start(); }, 10000);
    } finally { this.working = false; }
  }
}
