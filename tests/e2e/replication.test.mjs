import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron } from "playwright-core";
import { startWorkspaceServer } from "@workspace/server/initialization";

const require = createRequire(import.meta.url);
test("N35–N40 two actual desktop clients sync automatically within 30s, preserve unfinished input and resume offline work after restart", { timeout: 180000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-sync-window-"));
  const token = "desktop-sync-owner-credential-012345678900000";
  const serverDirectory = join(directory, "authority");
  let server = await startWorkspaceServer({ directory: serverDirectory, token });
  const url = server.url;
  const port = Number(new URL(url).port);
  const clientA = join(directory, "client-a"); const clientB = join(directory, "client-b");
  const launch = (client) => {
    const env = { ...process.env, WORKSPACE_CLIENT_DIRECTORY: client, WORKSPACE_SETUP_HIDDEN: "1" }; delete env.ELECTRON_RUN_AS_NODE;
    return _electron.launch({ executablePath: require("electron"), args: ["apps/desktop/dist/host/workspace-main.js"], env });
  };
  let a; let b;
  try {
    a = await launch(clientA); let pa = await a.firstWindow();
    await pa.getByRole("button", { name: "创建新工作空间", exact: true }).click();
    await pa.getByLabel("统一位置", { exact: true }).selectOption("remote");
    await pa.getByLabel("服务器地址", { exact: true }).fill(url);
    await pa.getByLabel("所有者接入凭据", { exact: true }).fill(token);
    await pa.getByRole("button", { name: "确认创建", exact: true }).click();
    await pa.getByLabel("任务内容", { exact: true }).fill("跨设备成果");
    await pa.getByRole("button", { name: "添加待办", exact: true }).click();
    await pa.getByTestId("captured-todo").getByText("跨设备成果", { exact: true }).waitFor();
    await pa.getByRole("button", { name: "立即同步", exact: true }).click();
    await pa.getByTestId("workspace-sync-status").getByText(/当前已保存改动已获统一位置确认/).waitFor();
    b = await launch(clientB); const pb = await b.firstWindow();
    await pb.getByRole("button", { name: "连接已有工作空间", exact: true }).click();
    await pb.getByLabel("已有空间位置", { exact: true }).selectOption("remote");
    await pb.getByLabel("已有服务器地址", { exact: true }).fill(url);
    await pb.getByLabel("已有空间接入凭据", { exact: true }).fill(token);
    await pb.getByRole("button", { name: "核验目标空间", exact: true }).click();
    await pb.getByRole("button", { name: "确认接入此空间", exact: true }).click();
    await pb.getByTestId("domain-builtin.todo").getByRole("button", { name: "进入领域", exact: true }).click();
    await pb.getByTestId("captured-todo").getByText("跨设备成果", { exact: true }).waitFor();
    // No manual sync on B: exercise the actual 10-second polling path.
    const start = Date.now();
    await pa.getByLabel("任务内容", { exact: true }).fill("自动同步时效");
    await pa.getByRole("button", { name: "添加待办", exact: true }).click();
    await pb.getByTestId("captured-todo").getByText("自动同步时效", { exact: true }).waitFor({ timeout: 30000 });
    assert.ok(Date.now() - start < 30000);
    const bindingA = JSON.parse(readFileSync(join(clientA, "binding.json"), "utf8"));
    const bindingB = JSON.parse(readFileSync(join(clientB, "binding.json"), "utf8"));
    assert.equal(bindingA.workspace.workspaceId, bindingB.workspace.workspaceId);
    assert.notEqual(bindingA.replicaPath, bindingB.replicaPath);
    // Unsubmitted new input must survive background receive and manual sync.
    await pb.getByLabel("任务内容", { exact: true }).fill("还没有提交的输入");
    await pb.getByRole("button", { name: "立即同步", exact: true }).click();
    assert.equal(await pb.getByLabel("任务内容", { exact: true }).inputValue(), "还没有提交的输入");
    await pb.getByLabel("任务内容", { exact: true }).fill("");
    await a.close(); a = undefined;
    await server.close(); server = undefined;
    a = await launch(clientA); pa = await a.firstWindow();
    await pa.getByTestId("captured-todo").getByText("跨设备成果", { exact: true }).waitFor();
    await pa.getByLabel("任务内容", { exact: true }).fill("离线保存后重启");
    await pa.getByRole("button", { name: "添加待办", exact: true }).click();
    await pa.getByTestId("captured-todo").getByText("离线保存后重启", { exact: true }).waitFor();
    await a.close(); a = await launch(clientA); pa = await a.firstWindow();
    await pa.getByTestId("captured-todo").getByText("离线保存后重启", { exact: true }).waitFor();
    server = await startWorkspaceServer({ directory: serverDirectory, token, port });
    await pa.getByRole("button", { name: "立即同步", exact: true }).click();
    await pb.getByRole("button", { name: "立即同步", exact: true }).click();
    await pb.getByTestId("captured-todo").getByText("离线保存后重启", { exact: true }).waitFor();
    await pa.screenshot({ path: ".build/replication-workspace.png" });
    assert.equal((await pb.getByTestId("captured-todo").getByText("离线保存后重启", { exact: true }).count()), 1);
  } finally {
    if (a) await a.close(); if (b) await b.close(); if (server) await server.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.split(/[/\\]/).at(-1)?.startsWith("workspace-sync-window-"));
    rmSync(directory, { recursive: true, force: true });
  }
});
