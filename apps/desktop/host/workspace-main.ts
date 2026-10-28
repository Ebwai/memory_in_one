import { DesktopUpdater, acknowledgeUpdate } from "./desktop-update.js";
import { DESKTOP_VERSION } from "../bridge/update-contracts.js";
import { dirname } from "node:path";
import { describeExportScope } from "@workspace/core";
import { installSyncFeatures } from "./sync-features.js";
import { installDomainFeatures, provisionTodo } from "./domain-features.js";
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpWorkspaceLocation, HttpSyncRemote, SqliteLocalStore, workspaceServiceUrl, deliverArchive, readArchive, recoverArchive, FileExtensionPrograms, authorityFromLocal } from "@workspace/adapters";
import { confirmMigrationBoundary, inspectExistingWorkspace, WorkspaceInitialization } from "@workspace/core";
import type { WorkspaceCreateResult } from "@workspace/contracts";
import type { ConnectionForm, ConnectionResult, WorkspaceBinding, WorkspaceForm, WorkspaceScreen, WorkspaceScreenResult } from "../bridge/workspace-contracts.js";

interface PrivateBinding extends WorkspaceBinding { readonly directory: string; readonly secret: string }
interface Pending extends WorkspaceForm { readonly secret: string; readonly outcome: "pending" | "rejected" | "unconfirmed" }
const servers = new Map<string, { url: string; stop: () => Promise<void> }>();
let window: BrowserWindow;
let stopSync: (() => Promise<void>) | undefined;
let base: string;
let binding: PrivateBinding | null = null;
let pending: Pending | null = null;
let problem: string | null = null;
let busy = false;
let stopping = false;
let stopped = false;
let updater: DesktopUpdater | undefined;

let connection: { ticket: string; target: PrivateBinding; token: string } | null = null;

// Existing locations must never acquire new authority files merely by opening them.
function existingLocalToken(directory: string): string {
  if (!isAbsolute(directory) || !existsSync(join(directory, "workspace.sqlite")) ||
      !existsSync(join(directory, ".workspace-owner.key"))) {
    throw new Error("本机位置不存在可接入空间或缺少接入凭据，请检查原目录；未创建新空间。");
  }
  return readFileSync(join(directory, ".workspace-owner.key"), "utf8").trim();
}

function readJson<T>(path: string): T | null { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : null; }

import { todoDefinition, TODO_DOMAIN } from "@workspace/todo-list";



function atomicJson(path: string, value: unknown): void {
  const temp = path + "." + randomUUID() + ".tmp";
  const descriptor = openSync(temp, "wx", 0o600);
  try { writeFileSync(descriptor, JSON.stringify(value)); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temp, path);
}
function publicBinding(value: PrivateBinding): WorkspaceBinding {
  return { workspace: value.workspace, kind: value.kind, location: value.location, endpoint: value.endpoint, replicaPath: value.replicaPath };
}
function check(event: IpcMainInvokeEvent): void {
  if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== window.webContents.getURL()) throw new Error("Unavailable caller");
}
async function encrypt(token: string): Promise<string> {
  if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error("系统凭据保护暂不可用，未以明文保存。");
  return (await safeStorage.encryptStringAsync(token)).toString("base64");
}
async function decrypt(secret: string): Promise<string> { return (await safeStorage.decryptStringAsync(Buffer.from(secret, "base64"))).result; }

function localToken(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, ".workspace-owner.key");
  if (!existsSync(path)) {
    try { writeFileSync(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  return readFileSync(path, "utf8").trim();
}
async function localServer(directory: string, token: string): Promise<string> {
  const existing = servers.get(directory);
  if (existing) return existing.url;
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../../server/dist/composition/main.js", import.meta.url))], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", WORKSPACE_DATA_DIRECTORY: directory,
      WORKSPACE_BOOTSTRAP_TOKEN: token, WORKSPACE_PORT: "0", WORKSPACE_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("本机服务未能及时启动。")); }, 10000);
    child.once("error", () => { clearTimeout(timeout); reject(new Error("本机服务无法启动。")); });
    child.once("exit", () => { clearTimeout(timeout); servers.delete(directory); reject(new Error("该位置已有服务运行，或本机服务暂不可用。")); });
    child.stderr.on("data", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      try {
        const ready = JSON.parse(buffer.split("\n")[0]!) as { type: string; url: string };
        if (ready.type !== "ready" || !ready.url.startsWith("http://127.0.0.1:")) throw new Error("Invalid service address");
        clearTimeout(timeout);
        servers.set(directory, { url: ready.url, stop: async () => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          await new Promise<void>((done) => { child.once("exit", () => done()); child.kill(); });
        } });
        resolve(ready.url);
      } catch { child.kill(); reject(new Error("本机服务未返回有效地址。")); }
    });
  });
}

app.whenReady().then(async () => {
  base = process.env.WORKSPACE_CLIENT_DIRECTORY ?? join(app.getPath("userData"), "workspace-initialization");
  mkdirSync(base, { recursive: true });
  try {
    binding = readJson<PrivateBinding>(join(base, "binding.json"));
    pending = readJson<Pending>(join(base, "pending.json"));
    if (binding && (!binding.workspace?.workspaceId || !binding.workspace.authorityId || !["local", "remote"].includes(binding.kind))) throw new Error("Invalid binding");
    if (pending && (!pending.creationId || !["local", "remote"].includes(pending.kind))) throw new Error("Invalid pending request");
  } catch { binding = null; pending = null; problem = "已有本机绑定或创建材料无法读取，未覆盖原文件。"; }
  const startup = (async () => {
    if (!binding || problem || !binding.endpoint && binding.kind === "remote") return;
    try {
      const token = binding.kind === "local" ? existingLocalToken(binding.directory) : await decrypt(binding.secret);
      const endpoint = binding.kind === "local" ? await localServer(binding.directory, token) : binding.endpoint;
      const identity = await new HttpWorkspaceLocation(endpoint, token).inspect();
      if (!identity || identity.workspaceId !== binding.workspace.workspaceId || identity.authorityId !== binding.workspace.authorityId) throw new Error("Identity mismatch");
      binding = { ...binding, endpoint, secret: binding.kind === "remote" ? await encrypt(token) : "" };
      atomicJson(join(base, "binding.json"), binding);
    } catch { problem = "已保留原空间绑定，但当前无法核对统一位置；未创建替代空间。"; }
  })();
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({ title: "统一工作空间", width: 1000, height: 820,
    show: process.env.WORKSPACE_SETUP_HIDDEN !== "1", backgroundColor: "#f4f5f7",
    webPreferences: { preload: fileURLToPath(new URL("../bridge/workspace-preload.cjs", import.meta.url)),
      nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
      offscreen: process.env.WORKSPACE_SETUP_HIDDEN === "1" } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("workspace:load", async (event): Promise<WorkspaceScreen> => {
    check(event); await startup;
    return { binding: binding ? publicBinding(binding) : null,
      pending: pending ? { creationId: pending.creationId, name: pending.name, kind: pending.kind, directory: pending.directory, url: pending.url } : null,
      defaultDirectory: join(base, "authority"), error: problem, pendingOutcome: pending?.outcome ?? null };
  });
  let recovery: { ticket: string; archive: import("@workspace/adapters").WorkspaceArchive; target: string; summary: import("@workspace/adapters").RecoverySummary; done: boolean } | null = null;
  ipcMain.handle("workspace:migration", async (event, action: unknown, raw: unknown) => {
    check(event); await startup;
    if (busy) throw new Error("另一个空间请求正在处理。");
    const original = binding;
    const workspace = original?.workspace ?? (recovery?.done ? recovery.summary.workspace : null);
    if (!workspace) throw new Error("请先接入原空间或完成原空间恢复。");
    const control = async (endpoint: string, token: string, method: string, isolated = false) => {
      const response = await fetch(endpoint + "/v1/mcp/migration-" + method, { method: "POST", headers: { authorization: "Bearer " + token }, body: JSON.stringify({ isolated }), signal: AbortSignal.timeout(15000) });
      const result = await response.json() as { state: string; workspaceId: string; authorityId: string; message?: string };
      if (!response.ok) throw new Error(result.message ?? "迁移状态无法确认。");
      if (result.workspaceId !== workspace.workspaceId || result.authorityId !== workspace.authorityId) throw new Error("迁移空间身份不匹配。");
      return result;
    };
    const oldControl = async (method: string) => {
      if (!original || original.kind === "remote" && !original.endpoint) throw new Error("尚未验证原统一位置。");
      const token = original.kind === "local" ? existingLocalToken(original.directory) : await decrypt(original.secret);
      const endpoint = original.kind === "local" ? await localServer(original.directory, token) : original.endpoint;
      return control(endpoint, token, method);
    };
    busy = true;
    try {
      if (action === "status" || action === "stop") {
        const result = await oldControl(action);
        return { state: result.state, message: result.state === "stopped" ? "旧统一位置已停止写入。请现在导出迁移材料；本机仍可留下待同步操作。" : "当前统一位置状态：" + result.state };
      }
      if (action !== "switch") throw new Error("无效迁移动作。");
      const form = raw as ConnectionForm & { isolated: boolean };
      if (!form || !["local", "remote"].includes(form.kind)) throw new Error("请选择已恢复的目标位置。");
      let oldState: "active" | "stopped" | "unreachable" = "unreachable";
      try { oldState = (await oldControl("status")).state === "stopped" ? "stopped" : "active"; } catch { /* Explicit isolation remains required when old state cannot be read. */ }
      confirmMigrationBoundary(workspace, workspace, oldState, form.isolated === true);
      let directory = form.directory;
      let promotedReplica: string | null = null;
      if (form.kind === "local" && recovery?.done && recovery.summary.source === "local" && resolve(directory) === resolve(recovery.target)) {
        if (form.isolated !== true) throw new Error("本机材料替代统一位置须明确接受材料覆盖边界并确认旧位置已停用或隔离。");
        const promoted = authorityFromLocal(recovery.archive);
        directory = join(recovery.target, "authority");
        await recoverArchive(promoted, directory, true, { [TODO_DOMAIN]: createHash("sha256").update(JSON.stringify(todoDefinition)).digest("hex") });
        promotedReplica = recovery.summary.databasePath;
      }
      if (form.kind === "local" && original?.kind === "local" && resolve(directory) === resolve(original.directory)) throw new Error("迁移目标必须区别于旧位置。");
      const token = form.kind === "local" ? localToken(directory) : form.token;
      const endpoint = form.kind === "local" ? await localServer(directory, token) : workspaceServiceUrl(form.url).href;
      if (original && endpoint === original.endpoint) throw new Error("迁移目标与旧位置相同。");
      const verifiedTarget = await inspectExistingWorkspace(new HttpWorkspaceLocation(endpoint, token), workspace);
      confirmMigrationBoundary(workspace, verifiedTarget, oldState, form.isolated === true);
      const status = await control(endpoint, token, "status");
      if (status.state !== "prepared" && status.state !== "active") throw new Error("目标不是已恢复的待启用位置。");
      // Activation is idempotent; a failed binding write can retry the same target.
      await control(endpoint, token, "activate", form.isolated === true);
      const replicaPath = original?.replicaPath ?? promotedReplica ?? join(base, "replicas", workspace.workspaceId, "replica.sqlite");
      const replica = await SqliteLocalStore.open({ databasePath: replicaPath }); await replica.close();
      const next: PrivateBinding = { workspace, kind: form.kind, directory, endpoint, location: form.kind === "local" ? directory : endpoint, replicaPath, secret: form.kind === "remote" ? await encrypt(token) : "" };
      atomicJson(join(base, "binding.json"), next); binding = next; problem = null;
      void sync.trigger(true);
      return { state: "active", binding: publicBinding(next), message: "已切换到同一空间的新位置。旧位置保持停写，本机原操作沿原身份补同步；其他离线设备仍需改接。" };
    } finally { busy = false; }
  });
  ipcMain.handle("workspace:recovery", async (event, action: unknown, ticket: unknown) => {
    check(event); await startup;
    if (busy) throw new Error("另一个空间请求正在处理。");
    busy = true;
    try {
      if (action === "preview") {
        const file = await dialog.showOpenDialog(window!, { title: "选择工作空间导出文件", properties: ["openFile"], filters: [{ name: "工作空间数据", extensions: ["json"] }] });
        if (file.canceled || !file.filePaths[0]) return null;
        const archive = await readArchive(file.filePaths[0]);
        const choice = await dialog.showOpenDialog(window!, { title: "选择空白恢复目录", properties: ["openDirectory", "createDirectory"] });
        if (choice.canceled || !choice.filePaths[0]) return null;
        const target = choice.filePaths[0];
        const summary = await recoverArchive(archive, target, false, { [TODO_DOMAIN]: createHash("sha256").update(JSON.stringify(todoDefinition)).digest("hex") });
        recovery = { ticket: randomUUID(), archive, target, summary, done: false };
      } else {
        const selected = recovery;
        if (!selected || typeof ticket !== "string" || ticket !== selected.ticket) throw new Error("恢复预览已失效，请重新选择材料和目标。");
        if (action === "restore") {
          selected.summary = await recoverArchive(selected.archive, selected.target, true, { [TODO_DOMAIN]: createHash("sha256").update(JSON.stringify(todoDefinition)).digest("hex") }); selected.done = true;
        } else if (action === "use-local") {
          if (!selected.done || selected.summary.source !== "local") throw new Error("请先完成本机来源恢复。");
          if (binding) throw new Error("当前已有工作空间绑定，已保留原本机进度。请在未绑定的客户端使用恢复结果。");
          const next: PrivateBinding = { workspace: selected.summary.workspace, kind: "remote", endpoint: "", directory: "", secret: "", location: "本机恢复：" + selected.target, replicaPath: selected.summary.databasePath };
          await new FileExtensionPrograms(join(base, "programs", next.workspace.workspaceId)).stage(todoDefinition);
          atomicJson(join(base, "binding.json"), next); binding = next; problem = null;
          return { ticket: selected.ticket, summary: selected.summary, binding: publicBinding(next) };
        } else throw new Error("无效恢复动作。");
      }
      return recovery ? { ticket: recovery.ticket, summary: recovery.summary } : null;
    } finally { busy = false; }
  });
  ipcMain.handle("workspace:export-file", async (event, source: unknown) => {
    check(event); await startup;
    if (!binding || (source !== "local" && source !== "authority")) throw new Error("请选择有效导出来源。");
    const selected = binding;
    const choice = await dialog.showSaveDialog(window!, { title: "保存工作空间导出文件", defaultPath: "工作空间.workspace.json", filters: [{ name: "工作空间数据", extensions: ["json"] }], properties: ["showOverwriteConfirmation"] });
    if (choice.canceled || !choice.filePath) return { cancelled: true };
    let archive: import("@workspace/adapters").WorkspaceArchive;
    if (source === "local") {
      const store = await SqliteLocalStore.open({ databasePath: selected.replicaPath, readOnly: true });
      try { archive = { workspace: selected.workspace, location: selected.location, snapshot: await store.snapshot(selected.workspace.workspaceId, "local") }; }
      finally { await store.close(); }
    } else {
      const token = selected.kind === "local" ? existingLocalToken(selected.directory) : await decrypt(selected.secret);
      const endpoint = selected.kind === "local" ? await localServer(selected.directory, token) : selected.endpoint;
      const response = await fetch(endpoint + "/v1/mcp/export-snapshot", { method: "POST", headers: { authorization: "Bearer " + token }, body: "{}", signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error("统一位置快照读取失败，未切换来源。");
      archive = await response.json() as import("@workspace/adapters").WorkspaceArchive;
      if (archive.workspace.workspaceId !== selected.workspace.workspaceId || archive.workspace.authorityId !== selected.workspace.authorityId || archive.snapshot.source !== "authority") throw new Error("来源空间身份不匹配。");
      archive = { ...archive, location: selected.location };
    }
    if (!binding || binding.workspace.workspaceId !== selected.workspace.workspaceId || binding.workspace.authorityId !== selected.workspace.authorityId || binding.location !== selected.location || binding.replicaPath !== selected.replicaPath) throw new Error("空间绑定已变化，请重新确认范围。");
    await deliverArchive(choice.filePath, archive, true);
    return { cancelled: false, path: choice.filePath, capturedAt: archive.snapshot.capturedAt };
  });
  ipcMain.handle("workspace:export-scope", async (event, source: unknown) => {
    check(event); await startup;
    if (!binding || !["authority", "local"].includes(String(source))) throw new Error("请选择有效导出来源。");
    if (source === "local") {
      const store = await SqliteLocalStore.open({ databasePath: binding.replicaPath, readOnly: true });
      try { return describeExportScope(binding.workspace, "local", binding.replicaPath, await store.exportInventory(binding.workspace.workspaceId, "local"), new Date().toISOString()); }
      finally { await store.close(); }
    }
    const token = binding.kind === "local" ? existingLocalToken(binding.directory) : await decrypt(binding.secret);
    const endpoint = binding.kind === "local" ? await localServer(binding.directory, token) : binding.endpoint;
    const response = await fetch(endpoint + "/v1/mcp/export-scope", { method: "POST", headers: { authorization: "Bearer " + token }, body: "{}", signal: AbortSignal.timeout(15000) });
    const result = await response.json() as import("@workspace/contracts").ExportScope;
    if (!response.ok || result.workspace?.workspaceId !== binding.workspace.workspaceId || result.workspace.authorityId !== binding.workspace.authorityId) throw new Error("无法完整读取原统一位置范围，未切换来源。");
    return { ...result, location: binding.location };
  });
  ipcMain.handle("workspace:mcp", async (event, method: unknown, input: unknown) => {
    check(event); await startup;
    if (!binding || typeof method !== "string" || !["grants", "calls", "directory", "grant-create", "grant-revoke"].includes(method)) throw new Error("管理请求不可用。");
    const token = binding.kind === "local" ? existingLocalToken(binding.directory) : await decrypt(binding.secret);
    const endpoint = binding.kind === "local" ? await localServer(binding.directory, token) : binding.endpoint;
    const identity = await new HttpWorkspaceLocation(endpoint, token).inspect();
    if (identity?.workspaceId !== binding.workspace.workspaceId || identity?.authorityId !== binding.workspace.authorityId) throw new Error("空间身份不匹配。");
    const response = await fetch(endpoint + "/v1/mcp/" + method, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(input ?? {}), signal: AbortSignal.timeout(15000) });
    const result = await response.json() as { message?: string };
    if (!response.ok) throw new Error(result.message ?? "管理结果尚不能确认，请刷新核对。");
    return result;
  });
  ipcMain.handle("workspace:choose-directory", async (event) => {
    check(event);
    const selected = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
    return selected.canceled ? null : selected.filePaths[0] ?? null;
  });
  ipcMain.handle("workspace:inspect", async (event, raw: unknown): Promise<ConnectionResult> => {
    check(event); await startup;
    if (busy) return { status: "rejected", message: "另一个空间请求正在处理，请稍后重试。" };
    connection = null;
    if (problem && !binding) return { status: "rejected", message: problem };
    if (pending && pending.outcome !== "rejected") return { status: "rejected", message: "请先核对原创建请求，接入不会替换待确认创建材料。" };
    const form = raw as ConnectionForm;
    if (!form || !["local", "remote"].includes(form.kind) ||
        typeof form.directory !== "string" || typeof form.url !== "string" || typeof form.token !== "string") {
      return { status: "rejected", message: "请填写有效的位置和接入凭据。" };
    }
    busy = true;
    try {
      const token = form.kind === "local" ? existingLocalToken(form.directory) : form.token;
      if (token.length < 32) throw new Error("请填写服务器提供的有效所有者接入凭据。");
      let endpoint: string;
      if (form.kind === "local") endpoint = await localServer(form.directory, token);
      else {
        try { endpoint = workspaceServiceUrl(form.url).href; }
        catch { throw new Error("服务器地址无效，请填写 HTTPS 地址；回环地址可使用 HTTP。"); }
      }
      const workspace = await inspectExistingWorkspace(new HttpWorkspaceLocation(endpoint, token), binding?.workspace ?? null);
      const target: PrivateBinding = { workspace, kind: form.kind, endpoint,
        directory: form.directory, location: form.kind === "local" ? form.directory : endpoint,
        replicaPath: binding?.replicaPath ?? join(base, "replicas", workspace.workspaceId, "replica.sqlite"),
        secret: form.kind === "remote" ? await encrypt(token) : "" };
      const ticket = randomUUID();
      connection = { ticket, target, token };
      return { status: "verified", ticket, workspace, location: target.location };
    } catch (error) {
      const message = error instanceof Error && /[\u4e00-\u9fff]/.test(error.message)
        ? error.message : "空间暂不可达或身份响应无效，请检查地址与服务状态；原绑定和本机进度已保留。";
      return { status: "rejected", message };
    } finally { busy = false; }
  });
  ipcMain.handle("workspace:connect", async (event, ticket: unknown): Promise<ConnectionResult> => {
    check(event); await startup;
    if (busy) return { status: "rejected", message: "另一个空间请求正在处理，请稍后重试。" };
    const verified = connection;
    if (!verified || typeof ticket !== "string" || verified.ticket !== ticket) {
      return { status: "rejected", message: "核验信息已失效，请重新核验目标空间。" };
    }
    connection = null;
    busy = true;
    try {
      const { target, token } = verified;
      await inspectExistingWorkspace(new HttpWorkspaceLocation(target.endpoint, token), target.workspace);
      if (binding && (binding.workspace.workspaceId !== target.workspace.workspaceId ||
          binding.workspace.authorityId !== target.workspace.authorityId)) throw new Error("原绑定已变化，请重新核验。");
      const replica = await SqliteLocalStore.open({ databasePath: target.replicaPath });
      await replica.close();
      atomicJson(join(base, "binding.json"), target);
      binding = target;
      void sync.trigger();
      problem = null;
      return { status: "connected", binding: publicBinding(target) };
    } catch (error) {
      return { status: "rejected", message: error instanceof Error && /[\u4e00-\u9fff]/.test(error.message)
        ? error.message : "暂时无法确认接入，原绑定及本机内容已保留，请重新核验。" };
    } finally { busy = false; }
  });
  ipcMain.handle("workspace:create", async (event, raw: unknown): Promise<WorkspaceScreenResult> => {
    check(event); await startup;
    if (busy) return { status: "unconfirmed", message: "原创建请求正在处理，请稍后核对。" };
    if (problem) return { status: "unconfirmed", message: problem };
    const form = raw as WorkspaceForm & { token: string };
    if (!form || typeof form.name !== "string" || !form.name.trim() || !/^[a-zA-Z0-9_-]{1,128}$/.test(form.creationId) || !["local", "remote"].includes(form.kind)) {
      return { status: "rejected", reason: "invalid-input", message: "请填写有效的工作空间名称与创建信息。" };
    }
    if (form.kind === "local" && (typeof form.directory !== "string" || !isAbsolute(form.directory))) {
      return { status: "rejected", reason: "invalid-input", message: "请选择本机的完整存放路径。" };
    }
    if (form.kind === "remote") {
      try { workspaceServiceUrl(form.url); } catch { return { status: "rejected", reason: "invalid-input", message: "请填写 HTTPS 服务器地址；本机回环地址可使用 HTTP。" }; }
    }
    connection = null;
    busy = true;
    let attempted = false;
    try {
      const name = form.name.trim();
      if (form.kind === "local" && (!form.directory || !isAbsolute(form.directory))) throw new Error("请选择本机的完整存放路径。");
      const prior = pending?.creationId === form.creationId ? pending : null;
      if (prior && (prior.name !== name || prior.kind !== form.kind || prior.directory !== form.directory || prior.url !== form.url)) {
        return { status: "rejected", reason: "request-mismatch", message: "原创建请求的名称或目标不同，请先核对原请求，未改动原创建材料。" };
      }
      const token = form.kind === "local" ? localToken(form.directory)
        : form.token || (prior?.secret ? await decrypt(prior.secret) : "");
      if (token.length < 32) throw new Error("请填写服务器提供的有效所有者接入凭据。");
      const endpoint = form.kind === "local" ? await localServer(form.directory, token) : workspaceServiceUrl(form.url).href;
      const secret = form.kind === "remote" ? await encrypt(token) : "";
      pending = { creationId: form.creationId, name, kind: form.kind, directory: form.directory, url: form.url, secret, outcome: "pending" };
      atomicJson(join(base, "pending.json"), pending);
      attempted = true;
      const location = new HttpWorkspaceLocation(endpoint, token);
      let result: WorkspaceCreateResult;
      if (prior && prior.outcome !== "rejected") {
        const found = await location.inspect();
        result = found ? found.creationId === form.creationId && found.name === name
          ? { status: "created", workspace: found }
          : { status: "rejected", reason: "target-occupied", message: "该位置已有空间，请使用已有空间接入，不会覆盖原空间。" }
          : await new WorkspaceInitialization(location, randomUUID, () => new Date().toISOString()).create({ creationId: form.creationId, name });
      } else {
        result = await new WorkspaceInitialization(location, randomUUID, () => new Date().toISOString()).create({ creationId: form.creationId, name });
      }
      if (result.status !== "created") {
        pending = { ...pending, outcome: result.status === "rejected" ? "rejected" : "unconfirmed" };
        atomicJson(join(base, "pending.json"), pending);
        return result;
      }
      const replicaPath = join(base, "replicas", result.workspace.workspaceId, "replica.sqlite");
      const replica = await SqliteLocalStore.open({ databasePath: replicaPath });
      await replica.close();
      const next: PrivateBinding = { workspace: result.workspace, kind: form.kind,
        location: form.kind === "local" ? form.directory : endpoint, endpoint, replicaPath, directory: form.directory, secret };
      await provisionTodo(next, base);
      atomicJson(join(base, "binding.json"), next);
      binding = next;
      void sync.trigger();
      try { unlinkSync(join(base, "pending.json")); } catch { /* Completed binding is the durable result. */ }
      pending = null;
      return { ...result, binding: publicBinding(next) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "创建结果暂不能确认，请按原操作重试。";
      return attempted ? { status: "unconfirmed", message } : { status: "rejected", reason: "unavailable", message };
    } finally { busy = false; }
  });
  const applicationRoot = dirname(process.execPath);
  let updateAcknowledged = false;
  let updateNotice: string | null = null;
  updater = new DesktopUpdater({ version: app.isPackaged ? app.getVersion() : DESKTOP_VERSION, packaged: app.isPackaged,
    root: applicationRoot, protectedPaths: () => [base, ...(binding ? [binding.replicaPath, ...(binding.kind === "local" ? [binding.location] : [])] : [])],
    close: () => window.close() });
  ipcMain.handle("workspace:update", async (event, action: unknown) => {
    check(event);
    if (!["status", "check", "download", "install"].includes(String(action))) throw new Error("无效更新动作。");
    if (!updateAcknowledged) { updateAcknowledged = true; updateNotice = await acknowledgeUpdate(applicationRoot, app.getVersion()); }
    if (action === "check") return updater!.check();
    if (action === "download") return updater!.download();
    if (action === "install") return updater!.install();
    const state = updater!.status();
    return updateNotice && state.phase === "idle" ? { ...state, message: updateNotice } : state;
  });
  let closeAllowed = false;
  window.on("close", (event) => {
    if (binding && !closeAllowed && !stopping) { event.preventDefault(); window.webContents.send("workspace:close-request"); return; }
    if (updater?.installationPending()) {
      event.preventDefault();
      void updater.launchInstaller().then(() => window.close()).catch((error: unknown) => {
        closeAllowed = false;
        updater?.installationFailed(error);
      });
    }
  });
  ipcMain.handle("workspace:window", (event, action: unknown) => {
    check(event);
    if (action === "close") { closeAllowed = true; window.close(); return; }
    if (action === "floating") { window.setAlwaysOnTop(true); window.setSize(440, 650); window.setTitle("待办随手记"); }
    else if (action === "management") { window.setAlwaysOnTop(false); window.setSize(1000, 820); window.setTitle("统一工作空间"); }
    else if (action === "pin") window.setAlwaysOnTop(true);
    else if (action === "unpin") window.setAlwaysOnTop(false);
    else throw new Error("无效窗口动作");
  });
  const sync = installSyncFeatures(check, () => binding ? publicBinding(binding) : null, async () => {
    if (!binding) throw new Error("请先选择工作空间。");
    if (binding.kind === "remote" && !binding.endpoint) throw new Error("恢复的本机进度尚未验证接入当前生效位置，可继续离线使用。");
    const token = binding.kind === "local" ? existingLocalToken(binding.directory) : await decrypt(binding.secret);
    if (binding.kind === "local") {
      const endpoint = await localServer(binding.directory, token);
      binding = { ...binding, endpoint };
    }
    return new HttpSyncRemote(binding.endpoint, token);
  }, () => base);
  stopSync = sync.stop;
  installDomainFeatures(check, () => binding ? publicBinding(binding) : null, () => base, () => { void sync.trigger(true); });
  void startup.then(() => sync.trigger());

  await window.loadFile(fileURLToPath(new URL("../renderer/workspace.html", import.meta.url)));
}).catch(() => app.exit(1));
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (stopped) return;
  event.preventDefault();
  if (stopping) return;
  stopping = true;
  void (async () => { await stopSync?.(); await Promise.all([...servers.values()].map((server) => server.stop())); })().finally(() => { stopped = true; app.quit(); });
});

