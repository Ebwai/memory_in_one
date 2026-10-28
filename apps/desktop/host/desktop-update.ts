import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, createWriteStream, openSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UpdateScreen } from "../bridge/update-contracts.js";
import { RELEASE_API, selectUpdate } from "./update-policy.js";
import type { UpdateOffer } from "./update-policy.js";

export function inside(directory: string, path: string): boolean {
  const rel = relative(resolve(directory), resolve(path));
  return rel === "" || rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../") && !isAbsolute(rel);
}

export async function downloadUpdate(offer: UpdateOffer, destination: string, progress: (percent: number) => void, request: typeof fetch = fetch): Promise<void> {
  const response = await request(offer.url, { headers: { "User-Agent": "memory-in-one-desktop" }, signal: AbortSignal.timeout(10 * 60000) });
  if (!response.ok || !response.body) throw new Error("下载失败，请检查 GitHub 网络连接后重试。");
  if (response.url) {
    const url = new URL(response.url);
    if (url.protocol !== "https:" || !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(url.hostname)) throw new Error("下载重定向来源无效。");
  }
  let size = 0;
  const hash = createHash("sha256");
  await pipeline(Readable.fromWeb(response.body as never), new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.length;
    if (size > offer.size) { callback(new Error("下载文件大小不匹配。")); return; }
    hash.update(chunk); progress(Math.floor(size / offer.size * 100)); callback(null, chunk);
  } }), createWriteStream(destination, { flags: "wx" }));
  if (size !== offer.size || hash.digest("hex") !== offer.sha256) throw new Error("下载文件校验失败，未替换当前程序。请重新下载。");
}

export async function runUpdateHelper(script: string, plan: string, mode: "Prepare" | "Apply"): Promise<void> {
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-PlanPath", plan, "-Mode", mode === "Apply" ? "Launch" : mode];
  await new Promise<void>((done, fail) => {
    const log = mode === "Apply" ? openSync(join(dirname(plan), "helper.log"), "a") : undefined;
    const child = spawn("powershell.exe", args, { windowsHide: true, stdio: log === undefined ? ["ignore", "ignore", "pipe"] : ["ignore", log, log] });
    if (mode === "Apply") {
      child.once("error", fail);
      child.once("exit", (code, signal) => { void writeFile(join(dirname(plan), "helper-exit.json"), JSON.stringify({ code, signal })).catch(() => {}); });
      child.once("spawn", () => { child.unref(); done(); });
      if (log !== undefined) closeSync(log);
      return;
    }
    let error = "";
    child.stderr?.on("data", chunk => { error = (error + chunk).slice(-2000); });
    const timer = setTimeout(() => { child.kill(); fail(new Error("解压超时，当前程序未修改。")); }, 180000);
    child.once("error", cause => { clearTimeout(timer); fail(cause); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? done() : fail(new Error("更新包解压或校验失败，当前程序未修改。" + error)); });
  });
}

interface UpdateOptions {
  version: string; packaged: boolean; root: string; protectedPaths: () => string[];
  close: () => void; request?: typeof fetch;
}

export class DesktopUpdater {
  private state: UpdateScreen;
  private offer: UpdateOffer | null = null;
  private working = false;
  private plan: string | null = null;
  private script: string | null = null;
  private installRequested = false;
  private launching = false;
  constructor(private readonly options: UpdateOptions) {
    this.state = { currentVersion: options.version, phase: "idle", canInstall: options.packaged && process.platform === "win32", message: "点击检查 GitHub 正式版本。" };
  }
  status(): UpdateScreen { return this.state; }
  private set(patch: Partial<UpdateScreen>): UpdateScreen { return this.state = { ...this.state, ...patch }; }
  private async protectData(): Promise<void> {
    const root = await realpath(this.options.root);
    for (const path of this.options.protectedPaths()) {
      let actual = resolve(path);
      try { actual = await realpath(path); } catch { /* Nonexistent paths still require lexical containment checks. */ }
      if (inside(root, actual) || inside(actual, root)) throw new Error("程序目录与数据目录重叠，请先将整个应用移到独立目录后再更新。");
    }
  }
  async check(): Promise<UpdateScreen> {
    if (this.working || this.state.phase === "ready") return this.state;
    this.working = true; this.offer = null;
    this.state = { currentVersion: this.options.version, phase: "checking", canInstall: this.state.canInstall, message: "正在检查 GitHub 正式版本…" };
    try {
      const response = await (this.options.request ?? fetch)(RELEASE_API, { headers: { Accept: "application/vnd.github+json", "User-Agent": "memory-in-one-desktop" }, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? "GitHub 请求受限，请稍后重试。" : "无法获取版本信息，请检查 GitHub 网络连接。");
      this.offer = selectUpdate(await response.json(), this.options.version, process.arch);
      if (!this.offer) return this.set({ phase: "current", message: "未发现更高版本的可用正式安装包。" });
      return this.set({ phase: "available", version: this.offer.version, notes: this.offer.notes, message: this.state.canInstall ? "发现新版本，可一键更新。" : "发现新版本。请使用 Windows 便携应用执行一键更新。" });
    } catch (error) { return this.set({ phase: "error", message: error instanceof Error ? error.message : "检查更新失败，请重试。" }); }
    finally { this.working = false; }
  }
  async download(): Promise<UpdateScreen> {
    if (this.working || this.state.phase === "ready") return this.state;
    if (!this.offer || !this.state.canInstall) return this.set({ phase: "error", message: "请先检查更新，并使用 Windows 便携应用安装。" });
    this.working = true; this.installRequested = false;
    this.set({ phase: "downloading", progress: 0, message: "正在下载新版，完成后将处理退出并安装…" });
    try {
      await this.protectData();
      const root = await realpath(this.options.root);
      const manifest = JSON.parse(await readFile(join(root, "workspace-release.json"), "utf8"));
      if (manifest.version !== this.options.version || manifest.platform !== "win32" || manifest.arch !== process.arch) throw new Error("当前应用安装信息不完整，请重新下载完整便携包。");
      await access(join(root, "工作空间.exe"));
      const stage = await mkdtemp(join(dirname(root), ".workspace-update-"));
      this.plan = join(stage, "plan.json"); this.script = join(stage, "update-helper.ps1");
      await copyFile(join(root, "resources/app/deploy/desktop/update-helper.ps1"), this.script);
      const archive = join(stage, "update.zip");
      await downloadUpdate(this.offer, archive, progress => this.set({ progress }), this.options.request);
      await writeFile(this.plan, JSON.stringify({ root, stage, archive, version: this.offer.version, arch: process.arch, parentPid: process.pid, executable: "工作空间.exe", sha256: this.offer.sha256 }), "utf8");
      this.set({ message: "下载完成，正在解压并核验新版…" });
      await runUpdateHelper(this.script, this.plan, "Prepare");
      this.set({ phase: "ready", progress: 100, message: "新版已准备好。将处理未保存输入后安装；取消退出后可再次点击安装并重启。" });
      await this.install();
    } catch (error) { this.plan = null; this.script = null; this.set({ phase: "error", message: error instanceof Error ? error.message : "准备更新失败，旧程序保留。" }); }
    finally { this.working = false; }
    return this.state;
  }
  async install(): Promise<UpdateScreen> {
    if (!this.plan || !this.script || this.state.phase !== "ready" || this.launching) return this.state;
    await this.protectData();
    this.installRequested = true; this.options.close(); return this.state;
  }
  installationPending(): boolean { return this.installRequested; }
  installationFailed(error: unknown): void {
    this.installRequested = false;
    this.set({ phase: "error", message: error instanceof Error ? error.message : "更新助手未能启动，当前程序继续运行。" });
  }
  // Called only after the existing window/draft close guard has accepted exit.
  async launchInstaller(): Promise<void> {
    if (!this.installRequested || !this.plan || !this.script) return;
    this.installRequested = false;
    this.launching = true;
    try {
      await runUpdateHelper(this.script, this.plan, "Apply");
      for (let attempt = 0; attempt < 100; attempt++) {
        try { await access(join(dirname(this.plan), "helper-started")); return; } catch { await delay(100); }
      }
      throw new Error("更新助手未能就绪，旧程序继续运行。请重新下载更新。");
    } catch (error) {
      await writeFile(join(dirname(this.plan), "abort"), "cancel").catch(() => {});
      throw error;
    } finally { this.launching = false; }
  }
}

export async function acknowledgeUpdate(root: string, version: string): Promise<string | null> {
  const planPath = process.env.WORKSPACE_UPDATE_PLAN;
  if (!planPath) return null;
  delete process.env.WORKSPACE_UPDATE_PLAN;
  try {
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    if (resolve(plan.root) !== resolve(root) || dirname(resolve(planPath)) !== resolve(plan.stage) || dirname(resolve(plan.stage)) !== dirname(resolve(root))) return null;
    try {
      const result = JSON.parse(await readFile(join(plan.stage, "result.json"), "utf8"));
      if (result.status === "rolled-back") return "上次更新未能启动，已恢复旧程序；工作空间数据保持原样。";
    } catch { /* A new program has no final result until its health acknowledgement. */ }
    if (plan.version === version) { await mkdir(plan.stage, { recursive: true }); await writeFile(join(plan.stage, "healthy"), version, "utf8"); }
  } catch { /* A stale update plan does not prevent normal application startup. */ }
  return null;
}
