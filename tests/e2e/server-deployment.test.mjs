import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const root = resolve(process.env.WORKSPACE_SERVER_RELEASE ?? ".build/release/workspace-server-v0.1.0");
const packaged = (name, file = "index.js") => import(pathToFileURL(join(root, "node_modules/@workspace", name, "dist", file)).href);

test("standalone distribution is intact and excludes desktop runtime", async () => {
  const manifest = JSON.parse(await readFile(join(root, "release.json"), "utf8"));
  assert.ok(manifest.platforms.includes("ubuntu-x64")); assert.ok(manifest.platforms.includes("windows-x64"));
  const lines = (await readFile(join(root, "SHA256SUMS"), "utf8")).trim().split("\n");
  for (const line of lines) {
    const [hash, path] = line.split("  ");
    assert.equal(createHash("sha256").update(await readFile(join(root, path))).digest("hex"), hash, path);
    assert.ok(!path.includes("apps/desktop") && !path.endsWith(".exe"), path);
  }
  const launch = await readFile(join(root, "deploy/server/ubuntu/start.sh"), "utf8");
  assert.ok(!launch.includes("\r"));
  assert.ok((await readFile(join(root, "deploy/server/windows/start-server.cmd"), "utf8")).includes("\r\n"));
});

test("native packaged server authenticates, persists synchronized facts and restores after restart", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-native-server-"));
  const token = "isolated-native-server-owner-0123456789";
  const data = join(directory, "authority");
  const env = { ...process.env, WORKSPACE_NODE_BINARY: process.execPath, WORKSPACE_DATA_DIRECTORY: data, WORKSPACE_BOOTSTRAP_TOKEN: token, WORKSPACE_HOST: "127.0.0.1", WORKSPACE_PORT: "0" };
  let child, store;
  async function stop(process) {
    if (!process || process.exitCode !== null || process.signalCode !== null) return;
    const done = new Promise(resolve => process.once("exit", resolve));
    if (globalThis.process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(process.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else process.kill();
    await done;
  }
  async function start() {
    const process = processPlatform() === "linux"
      ? spawn("bash", [join(root, "deploy/server/ubuntu/start.sh")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
      : spawn("cmd.exe", ["/d", "/c", '"' + join(root, "deploy/server/windows/start-server.cmd") + '"'], { cwd: root, env, windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"] });
    child = process;
    return await new Promise((resolve, reject) => {
      let output = "", errors = "";
      const timeout = setTimeout(() => reject(new Error("Native server startup timed out: " + errors)), 15000);
      process.stderr.on("data", value => { errors += value; });
      process.once("error", error => { clearTimeout(timeout); reject(error); });
      process.once("exit", () => { clearTimeout(timeout); reject(new Error("Native server exited: " + errors)); });
      process.stdout.on("data", chunk => { output += chunk; if (output.includes("\n")) { clearTimeout(timeout); try { resolve(JSON.parse(output.split("\n")[0]).url); } catch (error) { reject(error); } } });
    });
  }
  function processPlatform() { return globalThis.process.platform; }
  try {
    const { SqliteLocalStore, HttpWorkspaceLocation, HttpSyncRemote, FileExtensionPrograms, recoverArchive } = await packaged("adapters");
    const { WorkspaceInitialization, DomainRegistry, SyncEngine } = await packaged("core");
    const { todoDefinition, todoConflictPolicy, prepareTodo } = await packaged("todo-list");
    let url = await start();
    assert.equal((await fetch(url + "/v1/identity")).status, 401);
    const created = await new WorkspaceInitialization(new HttpWorkspaceLocation(url, token), () => "native-space", () => new Date().toISOString()).create({ name: "跨平台服务", creationId: "native-create" });
    assert.equal(created.status, "created");
    const identity = created.workspace;
    store = await SqliteLocalStore.open({ databasePath: join(directory, "client.sqlite") });
    const registry = new DomainRegistry(identity.workspaceId, store, new FileExtensionPrograms(join(directory, "programs")));
    await registry.register(todoDefinition, "register"); await registry.setEnabled("builtin.todo", true, "enable");
    await store.commit({ workspaceId: identity.workspaceId, domainId: "builtin.todo", recordId: "task", operationId: "save", kind: "put", payloadJson: JSON.stringify(prepareTodo("Ubuntu 和 Windows 共用的进度", new Date().toISOString())) });
    const policies = id => id === "builtin.todo" ? todoConflictPolicy : { attributes: { enabled: ["enabled"] }, validate: () => undefined };
    assert.deepEqual(await new SyncEngine(identity, store, new HttpSyncRemote(url, token), policies).run(), []);
    assert.equal((await store.syncSummary(identity.workspaceId)).pending, 0);
    const health = spawnSync(globalThis.process.execPath, [join(root, "scripts/check-server.mjs")], { cwd: root, env: { ...env, WORKSPACE_PORT: new URL(url).port }, encoding: "utf8", windowsHide: true });
    assert.equal(health.status, 0, health.stderr);
    const duplicate = spawn(globalThis.process.execPath, [join(root, "apps/server/dist/composition/main.js")], { cwd: root, env, windowsHide: true, stdio: "ignore" });
    const duplicateExit = await new Promise((resolve, reject) => { const timer = setTimeout(() => { void stop(duplicate); reject(new Error("Duplicate writer not rejected")); }, 5000); duplicate.once("exit", code => { clearTimeout(timer); resolve(code); }); });
    assert.notEqual(duplicateExit, 0);
    await stop(child); url = await start();
    assert.deepEqual(await new HttpWorkspaceLocation(url, token).inspect(), identity);
    const response = await fetch(url + "/v1/mcp/export-snapshot", { method: "POST", headers: { authorization: "Bearer " + token }, body: "{}" });
    assert.equal(response.ok, true);
    const archive = await response.json();
    assert.ok(JSON.stringify(archive.snapshot).includes("Ubuntu 和 Windows 共用的进度"));
    const restored = await recoverArchive(archive, join(directory, "restored"), true);
    assert.equal(restored.state, "prepared");
    const restoredStore = await SqliteLocalStore.open({ databasePath: restored.databasePath });
    try { assert.equal((await restoredStore.authorityRead({ workspaceId: identity.workspaceId, domainId: "builtin.todo", recordId: "task" })).value.text, "Ubuntu 和 Windows 共用的进度"); }
    finally { await restoredStore.close(); }
  } finally { await store?.close(); await stop(child); await rm(directory, { recursive: true, force: true }); }
});

test("Ubuntu shell, runtime preflight and systemd unit validate", { skip: process.platform !== "linux" }, async () => {
  for (const file of ["install.sh", "start.sh"]) {
    const check = spawnSync("bash", ["-n", join(root, "deploy/server/ubuntu", file)], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
  }
  const check = spawnSync("bash", [join(root, "deploy/server/ubuntu/install.sh"), "--check"], { cwd: root, env: { ...process.env, WORKSPACE_NODE_BINARY: process.execPath }, encoding: "utf8" });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const directory = await mkdtemp(join(tmpdir(), "workspace-unit-verify-"));
  try {
    await chmod(join(root, "deploy/server/ubuntu/start.sh"), 0o755);
    const unit = (await readFile(join(root, "deploy/server/ubuntu/personal-workspace.service"), "utf8"))
      .replaceAll("/opt/personal-workspace/current", root).replace("User=personal-workspace", "User=" + process.getuid()).replace("Group=personal-workspace", "Group=" + process.getgid())
      .replace("EnvironmentFile=/etc/personal-workspace/server.env", "EnvironmentFile=-/etc/personal-workspace/server.env");
    const path = join(directory, "personal-workspace.service"); await writeFile(path, unit);
    const result = spawnSync("systemd-analyze", ["verify", "--man=no", path], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
