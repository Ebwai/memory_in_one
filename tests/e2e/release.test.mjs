import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { _electron } from "playwright-core";

test("N62 distributed standalone server and bundled MCP entry run independently", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-server-release-"));
  const root = resolve(".build/release/workspace-server-v0.1.0");
  const token = "release-owner-for-isolated-test-0123456789";
  const server = spawn(process.execPath, [join(root, "apps/server/dist/composition/main.js")], { cwd: root, env: { ...process.env, WORKSPACE_DATA_DIRECTORY: directory, WORKSPACE_BOOTSTRAP_TOKEN: token, WORKSPACE_PORT: "0" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let client;
  try {
    const url = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("Packaged server did not start")), 15000);
      server.once("error", reject); server.once("exit", () => { clearTimeout(timer); reject(new Error("Packaged server stopped")); });
      server.stdout.on("data", chunk => { buffer += chunk; if (buffer.includes("\n")) { clearTimeout(timer); try { resolve(JSON.parse(buffer.split("\n")[0]).url); } catch (error) { reject(error); } } });
      server.stderr.on("data", () => {});
    });
    const post = async (method, body) => {
      const response = await fetch(url + method, { method: "POST", headers: { authorization: "Bearer " + token }, body: JSON.stringify(body) });
      assert.equal(response.ok, true); return response.json();
    };
    assert.equal((await post("/v1/initialize", { creationId: "packaged-server", name: "交付服务" })).status, "created");
    const grant = await post("/v1/mcp/grant-create", { name: "交付 MCP", domains: ["example.release"], actions: ["register"] });
    client = new Client({ name: "release-verifier", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "apps/mcp/protocol/main.mjs")], env: { WORKSPACE_MCP_URL: url, WORKSPACE_MCP_TOKEN: grant.credential }, stderr: "pipe" }));
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === "domain_register"));
  } finally {
    await client?.close();
    if (server.exitCode === null) { const stopped = new Promise(resolve => server.once("exit", resolve)); server.kill(); await stopped; }
    await rm(directory, { recursive: true, force: true });
  }
});

test("N62 distributed Windows executable starts without source arguments and recovers saved task after restart", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-release-ui-"));
  const env = { ...process.env, WORKSPACE_CLIENT_DIRECTORY: directory, WORKSPACE_SETUP_HIDDEN: "1" }; delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = resolve(".build/release/workspace-windows-v0.1.0/工作空间.exe");
  let app;
  try {
    app = await _electron.launch({ executablePath, args: [], env });
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "创建新工作空间", exact: true }).click();
    await page.getByRole("button", { name: "确认创建", exact: true }).click();
    await page.getByLabel("任务内容", { exact: true }).fill("交付包重启验证");
    await page.getByRole("button", { name: "添加待办", exact: true }).click();
    await page.getByTestId("captured-todo").getByText("交付包重启验证", { exact: true }).waitFor();
    await app.close(); app = undefined;
    app = await _electron.launch({ executablePath, args: [], env });
    page = await app.firstWindow();
    await page.getByTestId("captured-todo").getByText("交付包重启验证", { exact: true }).waitFor();
    assert.equal(await page.getByTestId("captured-todo").getByText("交付包重启验证", { exact: true }).count(), 1);
    await page.screenshot({ path: ".build/release.png", fullPage: true });
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
});
