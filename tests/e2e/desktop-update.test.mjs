import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile, mkdir, copyFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron, chromium } from "playwright-core";
import { selectUpdate, compareVersions } from "../../apps/desktop/dist/host/update-policy.js";
import { DESKTOP_VERSION } from "../../apps/desktop/dist/bridge/update-contracts.js";
import { DesktopUpdater, downloadUpdate, inside, runUpdateHelper } from "../../apps/desktop/dist/host/desktop-update.js";

const testRoot = resolve(".build/update-tests");
await mkdir(testRoot, { recursive: true });
const digest = "a".repeat(64);
function release(version, extra = {}) {
  return { tag_name: "v" + version, draft: false, prerelease: false, body: "发行说明", assets: [{
    name: `workspace-windows-v${version}-x64.zip`, digest: "sha256:" + digest, state: "uploaded", size: 100,
    browser_download_url: `https://github.com/Ebwai/memory_in_one/releases/download/v${version}/workspace-windows-v${version}-x64.zip`
  }], ...extra };
}

test("update chooses highest numeric stable version and rejects prerelease, architecture, source and digest mismatches", () => {
  assert.equal(compareVersions("v1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.1.0", "1.1.0"), 0);
  assert.throws(() => compareVersions("1.1.0-rc1", "1.0.0"));
  assert.equal(selectUpdate([release("1.2.0"), release("1.10.0"), release("9.0.0", { prerelease: true })], "1.1.0", "x64").version, "1.10.0");
  assert.equal(selectUpdate([release("1.1.0"), release("1.0.0")], "1.1.0", "x64"), null);
  assert.equal(selectUpdate([release("1.2.0")], "1.1.0", "arm64"), null);
  for (const override of [{ digest: null }, { state: "new" }, { browser_download_url: "https://example.com/evil.zip" }, { size: 2 ** 32 }]) {
    const candidate = release("1.2.0"); Object.assign(candidate.assets[0], override);
    assert.equal(selectUpdate([candidate], "1.1.0", "x64"), null);
  }
  assert.equal(inside("C:/app", "C:/app-copy/data"), false);
  assert.equal(inside("C:/app", "C:/app/data"), true);
});

test("checks distinguish rate limits, no update and real offer; overlapping checks are serialized", async () => {
  let calls = 0;
  let unblock;
  const pending = new Promise(done => { unblock = done; });
  const updater = new DesktopUpdater({ version: "1.1.0", packaged: false, root: tmpdir(), protectedPaths: () => [], close: () => assert.fail("must not close"), request: async () => { calls++; await pending; return Response.json([release("1.2.0")]); } });
  const checking = updater.check(); await updater.check(); assert.equal(calls, 1); unblock();
  assert.equal((await checking).phase, "available");
  assert.equal(updater.status().canInstall, false);
  assert.equal((await updater.download()).phase, "error");
  const limited = new DesktopUpdater({ version: "1.1.0", packaged: false, root: tmpdir(), protectedPaths: () => [], close() {}, request: async () => new Response("", { status: 403 }) });
  assert.equal((await limited.check()).phase, "error");
  assert.match(limited.status().message, /受限/);
});

test("download streams verify byte count and SHA256 before installation", async () => {
  const directory = await mkdtemp(join(testRoot, "workspace-update-download-"));
  try {
    const data = Buffer.from("test update package");
    const offer = { version: "1.2.0", url: "https://github.com/test", notes: "", size: data.length, sha256: createHash("sha256").update(data).digest("hex") };
    await downloadUpdate(offer, join(directory, "valid.zip"), () => {}, async () => new Response(data));
    assert.deepEqual(await readFile(join(directory, "valid.zip")), data);
    await assert.rejects(downloadUpdate({ ...offer, sha256: digest }, join(directory, "broken.zip"), () => {}, async () => new Response(data)), /校验失败/);
    await assert.rejects(downloadUpdate({ ...offer, size: 1 }, join(directory, "oversize.zip"), () => {}, async () => new Response(data)), /大小不匹配/);
    await assert.rejects(downloadUpdate(offer, join(directory, "http.zip"), () => {}, async () => new Response("", { status: 503 })), /下载失败/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function powershell(script, env = {}) {
  return new Promise((done, fail) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, ...env }, windowsHide: true });
    let output = "";
    child.stderr.on("data", data => { output += data; });
    child.once("error", fail); child.once("exit", code => code === 0 ? done() : fail(new Error(output)));
  });
}

async function fixture(parent, version = "1.2.0") {
  const stage = await mkdtemp(join(parent, ".workspace-update-"));
  const input = join(stage, "input", "client");
  await mkdir(join(input, "resources/app/apps/desktop/dist/host"), { recursive: true });
  await writeFile(join(input, "resources/app/apps/desktop/dist/host/workspace-main.js"), "// fixture");
  await writeFile(join(input, "resources/app/package.json"), JSON.stringify({ name: "personal-information-workspace", version, main: "apps/desktop/dist/host/workspace-main.js" }));
  await writeFile(join(input, "workspace-release.json"), JSON.stringify({ version, platform: "win32", arch: "x64" }));
  // Powershell.exe exits immediately when launched without input: deliberately unhealthy executable.
  await copyFile(join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), join(input, "工作空间.exe"));
  const archive = join(stage, "update.zip");
  await powershell("Compress-Archive -LiteralPath $env:FIXTURE_INPUT -DestinationPath $env:FIXTURE_ARCHIVE", { FIXTURE_INPUT: input, FIXTURE_ARCHIVE: archive });
  const planPath = join(stage, "plan.json");
  const root = join(parent, "client");
  const plan = { root, stage, archive, executable: "工作空间.exe", version, arch: "x64", parentPid: 2147483647, sha256: createHash("sha256").update(await readFile(archive)).digest("hex") };
  await writeFile(planPath, JSON.stringify(plan));
  const helper = join(stage, "helper.ps1");
  await writeFile(helper, "\uFEFF" + await readFile("deploy/desktop/update-helper.ps1", "utf8"));
  return { stage, planPath, root, helper, plan };
}

test("Windows helper validates ZIP and restores previous program when new executable cannot start", { skip: process.platform !== "win32", timeout: 90000 }, async () => {
  const parent = await mkdtemp(join(testRoot, "workspace-update-rollback-"));
  try {
    const f = await fixture(parent);
    await mkdir(f.root); await writeFile(join(f.root, "old-program.txt"), "original");
    await copyFile(process.execPath, join(f.root, "工作空间.exe"));
    await writeFile(join(parent, "user-data.txt"), "do not touch");
    await runUpdateHelper(f.helper, f.planPath, "Prepare");
    await assert.rejects(powershell("& $env:FIXTURE_HELPER -PlanPath $env:FIXTURE_PLAN -Mode Apply -HealthTimeoutSeconds 2", { FIXTURE_HELPER: f.helper, FIXTURE_PLAN: f.planPath }));
    assert.equal(await readFile(join(f.root, "old-program.txt"), "utf8"), "original");
    assert.equal(await readFile(join(parent, "user-data.txt"), "utf8"), "do not touch");
    assert.equal(JSON.parse(await readFile(join(f.stage, "result.json"), "utf8")).status, "rolled-back");
  } finally {
    await powershell("Get-Process | Where-Object { $_.Path -eq $env:FIXTURE_OLD_EXE } | Stop-Process -Force", { FIXTURE_OLD_EXE: join(parent, "client", "工作空间.exe") });
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("Windows helper rejects ZIP traversal before extracting anything", { skip: process.platform !== "win32", timeout: 30000 }, async () => {
  const parent = await mkdtemp(join(testRoot, "workspace-update-traversal-"));
  try {
    const f = await fixture(parent);
    await powershell("Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::Open($env:FIXTURE_ARCHIVE, 'Update'); $null=$z.CreateEntry('../escaped.txt'); $z.Dispose()", { FIXTURE_ARCHIVE: f.plan.archive });
    f.plan.sha256 = createHash("sha256").update(await readFile(f.plan.archive)).digest("hex");
    await writeFile(f.planPath, JSON.stringify(f.plan));
    await assert.rejects(runUpdateHelper(f.helper, f.planPath, "Prepare"), /校验失败/);
    assert.equal((await readdir(f.stage)).includes("extracted"), false);
    assert.equal((await readdir(parent)).includes("escaped.txt"), false);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("real desktop update panel checks releases without credentials and keeps unsaved task on cancelled update exit", { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(testRoot, "workspace-update-ui-"));
  const env = { ...process.env, WORKSPACE_CLIENT_DIRECTORY: directory, WORKSPACE_SETUP_HIDDEN: "1" }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({ executablePath: resolve(".build/release/workspace-windows-v0.1.0/工作空间.exe"), args: [], env });
    const page = await app.firstWindow();
    await page.getByTestId("app-update").getByText(`当前版本：${DESKTOP_VERSION}`, { exact: true }).waitFor();
    await app.evaluate(() => { globalThis.originalFetchForUpdateTest = globalThis.fetch; globalThis.fetch = async (url, options) => {
      if (String(url).startsWith("https://api.github.com/repos/Ebwai/memory_in_one/releases")) {
        if (options.headers.authorization) throw new Error("Unexpected workspace credential");
        return Response.json([]);
      }
      throw new Error("Unexpected network call");
    }; });
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    await page.getByText("未发现更高版本的可用正式安装包。", { exact: true }).waitFor();
    // Restore real fetch so local workspace creation can proceed.
    await app.evaluate(() => { globalThis.fetch = globalThis.originalFetchForUpdateTest; delete globalThis.originalFetchForUpdateTest; });
    await page.getByRole("button", { name: "创建新工作空间", exact: true }).click();
    await page.getByRole("button", { name: "确认创建", exact: true }).click();
    await page.getByLabel("任务内容", { exact: true }).fill("更新前仍未保存的草稿");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await page.getByRole("group", { name: "处理未保存输入" }).waitFor();
    await page.getByRole("button", { name: "取消操作", exact: true }).click();
    assert.equal(await page.getByLabel("任务内容", { exact: true }).inputValue(), "更新前仍未保存的草稿");
    await page.getByRole("button", { name: "添加待办", exact: true }).click();
    await page.getByTestId("captured-todo").getByText("更新前仍未保存的草稿", { exact: true }).waitFor();
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("one-click update replaces a real portable app, restarts and preserves existing workspace and saved task", { skip: process.platform !== "win32", timeout: 240000 }, async () => {
  const parent = await mkdtemp(join(testRoot, "workspace-update-live-"));
  const root = join(parent, "installed-app");
  const next = join(parent, "download", "next-app");
  const data = join(parent, "data");
  const archive = join(parent, "new.zip");
  const nextVersion = "1.3.0";
  let app, browser, mainSocket, standalone, server;
  try {
    await cp(resolve(".build/release/workspace-windows-v0.1.0"), root, { recursive: true });
    await cp(root, next, { recursive: true });
    const packagePath = join(next, "resources/app/package.json");
    const pkg = JSON.parse(await readFile(packagePath, "utf8"));
    await writeFile(packagePath, JSON.stringify({ ...pkg, version: nextVersion }));
    await writeFile(join(next, "workspace-release.json"), JSON.stringify({ version: nextVersion, platform: "win32", arch: process.arch }));
    await powershell("Compress-Archive -LiteralPath $env:FIXTURE_INPUT -DestinationPath $env:FIXTURE_ARCHIVE", { FIXTURE_INPUT: next, FIXTURE_ARCHIVE: archive });
    const bytes = await readFile(archive);
    const candidate = release(nextVersion);
    candidate.assets[0].size = bytes.length;
    candidate.assets[0].digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    server = createServer((_request, response) => createReadStream(archive).pipe(response));
    await new Promise(done => server.listen(0, "127.0.0.1", done));
    const downloadUrl = "http://127.0.0.1:" + server.address().port;
    const env = { ...process.env, WORKSPACE_CLIENT_DIRECTORY: data, WORKSPACE_SETUP_HIDDEN: "1" }; delete env.ELECTRON_RUN_AS_NODE;
    // Exercise ordinary process exit and the surviving updater independently of
    // Playwright's Electron launch/teardown lifecycle.
    standalone = spawn(join(root, "工作空间.exe"), ["--inspect=0", "--remote-debugging-port=0"], { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    const endpoints = await new Promise((done, fail) => {
      let log = "";
      const timer = setTimeout(() => fail(new Error("Standalone debugger endpoints unavailable: " + log)), 15000);
      standalone.once("error", fail);
      standalone.stderr.on("data", chunk => {
        log += chunk;
        const node = /Debugger listening on (ws:\/\/[^\s]+)/.exec(log)?.[1];
        const chrome = /DevTools listening on (ws:\/\/[^\s]+)/.exec(log)?.[1];
        if (node && chrome) { clearTimeout(timer); done({ node, chrome }); }
      });
    });
    browser = await chromium.connectOverCDP(endpoints.chrome);
    mainSocket = new WebSocket(endpoints.node);
    await new Promise((done, fail) => { mainSocket.addEventListener("open", done, { once: true }); mainSocket.addEventListener("error", fail, { once: true }); });
    let page = browser.contexts()[0].pages()[0];
    if (!page) page = await browser.contexts()[0].waitForEvent("page");
    await page.getByRole("button", { name: "创建新工作空间", exact: true }).click();
    await page.getByRole("button", { name: "确认创建", exact: true }).click();
    await page.getByLabel("任务内容", { exact: true }).fill("一键更新后仍然存在");
    await page.getByRole("button", { name: "添加待办", exact: true }).click();
    await page.getByTestId("captured-todo").getByText("一键更新后仍然存在", { exact: true }).waitFor();
    const originalBinding = await readFile(join(data, "binding.json"), "utf8");
    await page.getByRole("button", { name: "工作空间管理", exact: true }).click();
    const mock = `(() => {
      const candidate = ${JSON.stringify(candidate)}, downloadUrl = ${JSON.stringify(downloadUrl)};
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (url, options) => {
        if (String(url).startsWith("https://api.github.com/repos/Ebwai/memory_in_one/releases")) return Response.json([candidate]);
        if (String(url) === candidate.assets[0].browser_download_url) {
          const response = await realFetch(downloadUrl, options); return new Response(response.body);
        }
        return realFetch(url, options);
      };
    })()`;
    await new Promise((done, fail) => {
      mainSocket.addEventListener("message", event => { const message = JSON.parse(event.data); if (message.id === 1) message.result?.exceptionDetails ? fail(new Error(JSON.stringify(message))) : done(); });
      mainSocket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: mock } }));
    });
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    await page.getByRole("button", { name: "一键更新", exact: true }).waitFor();
    const exited = new Promise(done => standalone.once("exit", done));
    // Closing the inspector avoids Node waiting for an attached debugger at process exit.
    mainSocket.close(); mainSocket = undefined;
    await page.getByRole("button", { name: "一键更新", exact: true }).click();
    await exited;
    await browser.close(); browser = undefined;
    let stage, result;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      stage = (await readdir(parent)).find(name => name.startsWith(".workspace-update-"));
      if (stage) {
        try { result = JSON.parse(await readFile(join(parent, stage, "result.json"), "utf8")); } catch {}
        if (result?.status === "installed") break;
        if (["rolled-back", "recovery-required", "aborted"].includes(result?.status)) assert.fail(JSON.stringify(result));
      }
      await delay(400);
    }
    assert.equal(result?.status, "installed");
    assert.equal(JSON.parse(await readFile(join(root, "workspace-release.json"), "utf8")).version, nextVersion);
    assert.equal(JSON.parse(await readFile(join(data, "binding.json"), "utf8")).workspace.workspaceId, JSON.parse(originalBinding).workspace.workspaceId);
    assert.equal(JSON.parse(await readFile(join(parent, stage, "previous/resources/app/package.json"), "utf8")).version, DESKTOP_VERSION);
    await powershell("Get-Process | Where-Object { $_.Path -eq $env:FIXTURE_OLD_EXE } | Stop-Process -Force", { FIXTURE_OLD_EXE: join(root, "工作空间.exe") });
    await delay(1000);
    app = await _electron.launch({ executablePath: join(root, "工作空间.exe"), args: [], env });
    page = await app.firstWindow();
    await page.getByTestId("captured-todo").getByText("一键更新后仍然存在", { exact: true }).waitFor();
  } finally {
    mainSocket?.close();
    await browser?.close();
    await app?.close();
    await powershell("Get-Process | Where-Object { $_.Path -eq $env:FIXTURE_OLD_EXE } | Stop-Process -Force", { FIXTURE_OLD_EXE: join(root, "工作空间.exe") });
    if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
