import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startWorkspaceServer } from "@workspace/server/initialization";
const require = createRequire(import.meta.url);

test("remote URL with trailing slash creates, lists and copies a grant", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-mcp-remote-"));
  const owner = "remote-owner-for-trailing-slash-test-0123456789";
  const server = await startWorkspaceServer({ directory: join(directory, "authority"), token: owner });
  const env = { ...process.env, WORKSPACE_CLIENT_DIRECTORY: join(directory, "client"), WORKSPACE_SETUP_HIDDEN: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: process.env.WORKSPACE_TEST_EXECUTABLE || require("electron"), args: process.env.WORKSPACE_TEST_EXECUTABLE ? [] : ["apps/desktop/dist/host/workspace-main.js"], env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.workspaceSetup);
    const result = await page.evaluate(async ({ url, token }) => {
      const created = await window.workspaceSetup.create({ creationId: "remote-slash", name: "尾斜杠回归", kind: "remote", directory: "", url, token });
      if (created.status !== "created") throw new Error("Remote setup failed");
      const authorization = await window.workspaceSetup.mcp("grant-create", { name: "远程测试", domains: ["*"], actions: ["read"] });
      const grants = await window.workspaceSetup.mcp("grants");
      const configuration = await window.workspaceSetup.mcp("configuration", { id: authorization.grant.id });
      const scope = await window.workspaceSetup.exportScope("authority");
      return { count: grants.length, saved: !!authorization.credential, configured: configuration.includes(authorization.credential), scoped: scope.workspace.workspaceId === created.workspace.workspaceId };
    }, { url: server.url + "/", token: owner });
    assert.deepEqual(result, { count: 1, saved: true, configured: true, scoped: true });
  } finally { await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("MCP full access, encrypted credentials survive restart, copy ready Codex configuration", { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-mcp-automation-"));
  const env = { ...process.env, WORKSPACE_CLIENT_DIRECTORY: directory, WORKSPACE_SETUP_HIDDEN: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => _electron.launch({ executablePath: process.env.WORKSPACE_TEST_EXECUTABLE || require("electron"), args: process.env.WORKSPACE_TEST_EXECUTABLE ? [] : ["apps/desktop/dist/host/workspace-main.js"], env });
  let app = await launch();
  const originalClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "创建新工作空间", exact: true }).click();
    await page.getByRole("button", { name: "确认创建", exact: true }).click();
    const nav = page.getByRole("navigation", { name: "管理导航" });
    await nav.getByRole("button", { name: "MCP", exact: false }).click();
    let manager = page.getByTestId("mcp-management");
    await manager.getByRole("button", { name: "打开 MCP 管理", exact: true }).click();
    await manager.getByLabel("接入名称", { exact: true }).fill("自动化测试");
    await manager.getByLabel(/^完全访问：/).check();
    assert.equal(await manager.getByLabel(/新领域身份/).count(), 0);
    await manager.getByRole("button", { name: "创建接入授权", exact: true }).click();
    const delivery = manager.getByTestId("mcp-credential");
    await delivery.waitFor();
    const created = JSON.parse(await delivery.locator("pre").textContent());
    assert.deepEqual(created.grant.domains, ["*"]);
    assert.ok(created.grant.actions.includes("delete-unattended"));
    assert.ok(created.grant.actions.includes("recovery"));
    await manager.getByRole("button", { name: "显示凭据", exact: true }).click();
    assert.equal(await manager.locator("code").textContent(), created.credential);
    await manager.getByRole("button", { name: "复制凭据", exact: true }).click();
    await manager.getByRole("status").filter({ hasText: "凭据已复制" }).waitFor();
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), created.credential);
    await manager.getByRole("button", { name: "复制 Codex 配置", exact: true }).click();
    await manager.getByText("Codex 配置已复制，已填入本机程序路径、服务地址和凭据。", { exact: true }).waitFor();
    const config = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert.ok(config.includes(created.credential));
    assert.ok(config.includes("\ncommand = "), "Copied TOML must contain real line breaks");
    assert.ok(config.includes('ELECTRON_RUN_AS_NODE = "1"'));
    const command = JSON.parse(config.match(/^command = (.+)$/m)[1]);
    const args = JSON.parse(config.match(/^args = (.+)$/m)[1]);
    const connectionEnv = Object.fromEntries([...config.matchAll(/^(ELECTRON_RUN_AS_NODE|WORKSPACE_MCP_URL|WORKSPACE_MCP_TOKEN) = (.+)$/gm)].map(([, key, value]) => [key, JSON.parse(value)]));
    const client = new Client({ name: "copied-codex-config-verifier", version: "1.0.0" });
    let diagnostic = "";
    try {
      const transport = new StdioClientTransport({ command, args, env: connectionEnv, stderr: "pipe" });
      transport.stderr?.on("data", chunk => { diagnostic += chunk; });
      try { await client.connect(transport); } catch (error) { throw new Error(error.message + " " + diagnostic.replaceAll(created.credential, "[redacted]")); }
      assert.ok((await client.listTools()).tools.some(t => t.name === "workspace_backup"));
      const backup = JSON.parse((await client.callTool({ name: "workspace_backup", arguments: { operationId: "copied-config-backup" } })).content[0].text);
      assert.equal(backup.status, "accepted");
    } finally { await client.close(); }
    const vault = await readFile(join(directory, "mcp-credentials.json"), "utf8");
    assert.equal(vault.includes(created.credential), false);
    await app.close();
    app = await launch(); page = await app.firstWindow();
    await page.getByRole("navigation", { name: "管理导航" }).getByRole("button", { name: "MCP", exact: false }).click();
    manager = page.getByTestId("mcp-management");
    await manager.getByRole("button", { name: "打开 MCP 管理", exact: true }).click();
    await manager.getByRole("button", { name: "显示凭据", exact: true }).click();
    assert.equal(await manager.locator("code").textContent(), created.credential);
    await manager.getByRole("button", { name: "撤销 自动化测试", exact: true }).click();
    await manager.getByText("此凭据已撤销，不可继续访问。", { exact: true }).waitFor();
    assert.equal(await manager.getByRole("button", { name: "复制 Codex 配置", exact: true }).count(), 0);
    await page.screenshot({ path: ".build/mcp-automation.png", fullPage: true });
  } finally {
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), originalClipboard).catch(() => {});
    await app.close(); await rm(directory, { recursive: true, force: true });
  }
});
