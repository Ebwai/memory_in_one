import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron } from "playwright-core";
import { startWorkspaceServer } from "@workspace/server/initialization";

const require = createRequire(import.meta.url);
async function launch(clientDirectory) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({ executablePath: require("electron"), args: ["apps/desktop/dist/host/workspace-main.js"],
    cwd: process.cwd(), timeout: 25000, env: { ...env, WORKSPACE_CLIENT_DIRECTORY: clientDirectory, WORKSPACE_SETUP_HIDDEN: "1" } });
}
function cleanup(directory) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(directory.split(/[/\\]/).at(-1)?.startsWith("workspace-setup-window-"));
  rmSync(directory, { recursive: true, force: true });
}

test("local workspace creation preserves invalid input, binds separate files and survives full restart", { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-setup-window-"));
  const client = join(directory, "client");
  let application;
  try {
    application = await launch(client);
    let page = await application.firstWindow();
    await page.getByRole("button", { name: "创建新工作空间", exact: true }).click();
    await page.getByLabel("工作空间名称", { exact: true }).fill("  ");
    await page.getByRole("button", { name: "确认创建", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByLabel("工作空间名称", { exact: true }).inputValue(), "  ");
    assert.equal(existsSync(join(client, "binding.json")), false);
    await page.getByLabel("工作空间名称", { exact: true }).fill("  我的独立工作空间  ");
    await page.getByRole("button", { name: "确认创建", exact: true }).click();
    await page.getByRole("button", { name: "工作空间管理", exact: true }).click();
    await page.getByTestId("workspace-created").waitFor({ timeout: 20000 });
    const id = await page.getByTestId("workspace-id").innerText();
    assert.match(id, /^[a-f0-9-]{36}$/);
    assert.equal(await page.getByTestId("workspace-created").getByRole("heading", { level: 2 }).innerText(), "我的独立工作空间");
    const saved = JSON.parse(readFileSync(join(client, "binding.json"), "utf8"));
    assert.equal(saved.workspace.workspaceId, id);
    assert.notEqual(saved.replicaPath, join(saved.location, "workspace.sqlite"));
    assert.equal(existsSync(saved.replicaPath), true);
    const db = new DatabaseSync(join(saved.location, "workspace.sqlite"), { readOnly: true });
    try { assert.equal(db.prepare("SELECT workspace_id FROM workspace_identity").get().workspace_id, id); }
    finally { db.close(); }
    mkdirSync(".build", { recursive: true });
    await page.screenshot({ path: ".build/workspace-created.png", fullPage: true, timeout: 8000 });
    await application.close(); application = undefined;
    application = await launch(client);
    page = await application.firstWindow();
    await page.getByRole("button", { name: "工作空间管理", exact: true }).click();
    await page.getByTestId("workspace-id").getByText(id, { exact: true }).waitFor({ timeout: 20000 });
    assert.match(await page.getByTestId("workspace-location").innerText(), /authority/);
    assert.equal(await page.getByRole("alert").count(), 0);
    await application.close(); application = undefined;

    application = await launch(join(directory, "another-client"));
    page = await application.firstWindow();
    await page.getByRole("button", { name: "创建新工作空间", exact: true }).click();
    await page.getByLabel("本机存放目录", { exact: true }).fill(saved.location);
    await page.getByRole("button", { name: "确认创建", exact: true }).click();
    await page.getByRole("alert").getByText(/已有/).waitFor({ timeout: 20000 });
    assert.equal(existsSync(join(directory, "another-client", "binding.json")), false);
    assert.equal(await page.getByLabel("本机存放目录", { exact: true }).inputValue(), saved.location);
  } finally { if (application) await application.close(); cleanup(directory); }
});

test("prepared remote service requires valid credentials and stores no plaintext client credential", { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-setup-window-"));
  const client = join(directory, "remote-client");
  const token = "remote-workspace-owner-credential-0123456789";
  const server = await startWorkspaceServer({ directory: join(directory, "server"), token });
  let application;
  try {
    application = await launch(client);
    let page = await application.firstWindow();
    await page.getByRole("button", { name: "创建新工作空间", exact: true }).click();
    await page.getByLabel("统一位置", { exact: true }).selectOption("remote");
    await page.getByLabel("服务器地址", { exact: true }).fill(server.url);
    await page.getByLabel("所有者接入凭据", { exact: true }).fill("wrong-owner-credential-012345678900000");
    await page.getByRole("button", { name: "确认创建", exact: true }).click();
    await page.getByRole("alert").getByText(/凭据无效/).waitFor({ timeout: 20000 });
    assert.equal(await page.getByLabel("服务器地址", { exact: true }).inputValue(), server.url);
    assert.equal(existsSync(join(client, "binding.json")), false);
    const originalPending = JSON.parse(readFileSync(join(client, "pending.json"), "utf8"));
    const changedTarget = await page.evaluate((original) => window.workspaceSetup.create({ ...original, name: "另一个名称", token: "" }), originalPending);
    assert.equal(changedTarget.status, "rejected");
    assert.equal(changedTarget.reason, "request-mismatch");
    assert.equal(JSON.parse(readFileSync(join(client, "pending.json"), "utf8")).name, originalPending.name);
    await application.close(); application = undefined;
    application = await launch(client);
    page = await application.firstWindow();
    await page.getByLabel("服务器地址", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("所有者接入凭据", { exact: true }).isDisabled(), false);
    await page.getByLabel("所有者接入凭据", { exact: true }).fill(token);
    await page.getByRole("button", { name: "确认创建", exact: true }).click();
    await page.getByRole("button", { name: "工作空间管理", exact: true }).click();
    await page.getByTestId("workspace-created").waitFor({ timeout: 20000 });
    const id = await page.getByTestId("workspace-id").innerText();
    const binding = readFileSync(join(client, "binding.json"), "utf8");
    assert.equal(binding.includes(token), false);
    assert.ok(JSON.parse(binding).secret.length > 0);
    assert.equal(existsSync(join(client, "pending.json")), false);
    const publicView = await page.evaluate(() => window.workspaceSetup.load());
    assert.equal(JSON.stringify(publicView).includes(token), false);
    await application.close(); application = undefined;
    application = await launch(client);
    page = await application.firstWindow();
    await page.getByRole("button", { name: "工作空间管理", exact: true }).click();
    await page.getByTestId("workspace-id").getByText(id, { exact: true }).waitFor({ timeout: 20000 });
    assert.equal(await page.getByRole("alert").count(), 0);
  } finally { if (application) await application.close(); await server.close(); cleanup(directory); }
});


async function initialize(server, token, id) {
  const response = await fetch(new URL("v1/initialize", server.url), {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ creationId: id, name: "同一个名称" }),
  });
  const result = await response.json();
  assert.equal(result.status, "created");
  return result.workspace;
}

test("existing remote workspace requires confirmation, preserves binding on failures and resumes offline", { timeout: 90000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-setup-window-"));
  const token = "existing-space-owner-credential-0123456789";
  const server = await startWorkspaceServer({ directory: join(directory, "server"), token });
  const other = await startWorkspaceServer({ directory: join(directory, "other"), token });
  const empty = await startWorkspaceServer({ directory: join(directory, "empty"), token });
  let application;
  let serverClosed = false;
  try {
    const identity = await initialize(server, token, "existing-request");
    const otherIdentity = await initialize(other, token, "other-request");
    assert.notEqual(identity.workspaceId, otherIdentity.workspaceId);
    const client = join(directory, "new-device");
    application = await launch(client);
    let page = await application.firstWindow();
    await page.getByRole("button", { name: "连接已有工作空间", exact: true }).click();
    await page.getByLabel("已有空间位置", { exact: true }).selectOption("remote");
    await page.getByLabel("已有服务器地址", { exact: true }).fill(server.url);
    await page.getByLabel("已有空间接入凭据", { exact: true }).fill(token);
    await page.getByRole("button", { name: "核验目标空间", exact: true }).click();
    await page.getByTestId("connection-preview").waitFor();
    assert.match(await page.getByTestId("connection-preview").innerText(), new RegExp(identity.workspaceId));
    assert.equal(existsSync(join(client, "binding.json")), false);
    await page.getByRole("button", { name: "确认接入此空间", exact: true }).click();
    await page.getByTestId("workspace-id").getByText(identity.workspaceId, { exact: true }).waitFor();
    const original = readFileSync(join(client, "binding.json"), "utf8");
    assert.equal(original.includes(token), false);
    const binding = JSON.parse(original);
    const replica = readFileSync(binding.replicaPath);
    for (const [url, credential, message] of [
      [other.url, token, /身份.*不一致/],
      [server.url, "invalid-owner-credential-01234567890000", /凭据无效/],
      [empty.url, token, /不存在工作空间/],
      ["http://127.0.0.1:1/", token, /不可达/],
      ["http://example.com/", token, /地址无效/],
    ]) {
      const result = await page.evaluate(async ({ url, token }) => window.workspaceSetup.inspect({ kind: "remote", directory: "", url, token }), { url, token: credential });
      assert.equal(result.status, "rejected");
      assert.match(result.message, message);
      assert.equal(readFileSync(join(client, "binding.json"), "utf8"), original);
      assert.deepEqual(readFileSync(binding.replicaPath), replica);
    }
    assert.equal(existsSync(join(directory, "empty", "workspace.sqlite")), false);
    const preview = await page.evaluate(async ({ url, token }) => window.workspaceSetup.inspect({ kind: "remote", directory: "", url, token }), { url: server.url, token });
    assert.equal(preview.status, "verified");
    await server.close(); serverClosed = true;
    const failed = await page.evaluate((ticket) => window.workspaceSetup.connect(ticket), preview.ticket);
    assert.equal(failed.status, "rejected");
    assert.equal(readFileSync(join(client, "binding.json"), "utf8"), original);
    await application.close(); application = undefined;
    application = await launch(client);
    page = await application.firstWindow();
    await page.getByTestId("workspace-id").getByText(identity.workspaceId, { exact: true }).waitFor();
    await page.getByRole("alert").getByText(/已保留原空间绑定/).waitFor();
    assert.equal(readFileSync(join(client, "binding.json"), "utf8"), original);
    assert.deepEqual(readFileSync(binding.replicaPath), replica);
    assert.equal(await page.getByRole("button", { name: "重新核验已有空间", exact: true }).isEnabled(), true);
  } finally {
    if (application) await application.close();
    if (!serverClosed) await server.close();
    await other.close(); await empty.close(); cleanup(directory);
  }
});

test("existing local connection never creates a missing target and reconnects the original identity", { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-setup-window-"));
  let application;
  try {
    const owner = join(directory, "owner");
    application = await launch(owner);
    let page = await application.firstWindow();
    await page.getByRole("button", { name: "创建新工作空间", exact: true }).click();
    await page.getByRole("button", { name: "确认创建", exact: true }).click();
    await page.getByRole("button", { name: "工作空间管理", exact: true }).click();
    await page.getByTestId("workspace-created").waitFor();
    const original = JSON.parse(readFileSync(join(owner, "binding.json"), "utf8"));
    await application.close(); application = undefined;
    const client = join(directory, "new-client");
    application = await launch(client); page = await application.firstWindow();
    await page.getByRole("button", { name: "连接已有工作空间", exact: true }).click();
    const missing = join(directory, "missing");
    await page.getByLabel("已有空间目录", { exact: true }).fill(missing);
    await page.getByRole("button", { name: "核验目标空间", exact: true }).click();
    await page.getByRole("alert").getByText(/不存在可接入空间/).waitFor();
    assert.equal(existsSync(missing), false);
    assert.equal(await page.getByLabel("已有空间目录", { exact: true }).inputValue(), missing);
    await page.getByLabel("已有空间目录", { exact: true }).fill(original.directory);
    await page.getByRole("button", { name: "核验目标空间", exact: true }).click();
    await page.getByTestId("connection-preview").waitFor();
    await page.getByRole("button", { name: "确认接入此空间", exact: true }).click();
    await page.getByTestId("workspace-id").getByText(original.workspace.workspaceId, { exact: true }).waitFor();
    const connected = JSON.parse(readFileSync(join(client, "binding.json"), "utf8"));
    assert.notEqual(connected.replicaPath, original.replicaPath);
    assert.equal(connected.workspace.authorityId, original.workspace.authorityId);
    mkdirSync(".build", { recursive: true });
    await page.screenshot({ path: ".build/workspace-connected.png", fullPage: true });
  } finally { if (application) await application.close(); cleanup(directory); }
});
