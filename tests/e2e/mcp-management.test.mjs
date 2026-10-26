import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";
const require = createRequire(import.meta.url);

test("N49–N50 desktop creates and revokes scoped grants, displays records and confirms both export sources", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-mcp-ui-"));
  const env = { ...process.env, WORKSPACE_CLIENT_DIRECTORY: directory, WORKSPACE_SETUP_HIDDEN: "1" }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: require("electron"), args: ["apps/desktop/dist/host/workspace-main.js"], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "创建新工作空间", exact: true }).click();
    await page.getByRole("button", { name: "确认创建", exact: true }).click();
    await page.getByRole("button", { name: "工作空间管理", exact: true }).click();
    await page.getByTestId("workspace-created").waitFor();
    await page.getByRole("button", { name: "立即同步", exact: true }).click();
    const manager = page.getByTestId("mcp-management");
    await manager.getByRole("button", { name: "打开 MCP 管理", exact: true }).click();
    await manager.getByLabel("接入名称", { exact: true }).fill("桌面测试来源");
    await manager.getByLabel(/builtin.todo/).check();
    assert.equal(await manager.getByLabel("内容查询", { exact: true }).isChecked(), true);
    assert.equal(await manager.getByLabel("删除（逐次确认）", { exact: true }).isChecked(), false);
    await manager.getByRole("button", { name: "创建接入授权", exact: true }).click();
    await manager.getByTestId("mcp-credential").waitFor();
    await manager.getByRole("button", { name: "隐藏凭据", exact: true }).click();
    await manager.getByRole("button", { name: "撤销 桌面测试来源", exact: true }).click();
    await manager.getByText(/工作空间所有者 · grant-revoke · 已确认成功/).waitFor();
    const panel = page.getByTestId("export-scope");
    await panel.getByRole("button", { name: "选择导出范围", exact: true }).click();
    await panel.getByRole("button", { name: "查看所选来源范围", exact: true }).click();
    await panel.getByTestId("export-preview").getByText(/来源：统一位置/).waitFor();
    await panel.getByRole("button", { name: "确认按此来源范围继续", exact: true }).click();
    await panel.getByRole("status").getByText(/范围已确认/).waitFor();
    await panel.getByLabel("导出来源", { exact: true }).selectOption("local");
    assert.equal(await panel.getByTestId("export-preview").count(), 0);
    await panel.getByRole("button", { name: "查看所选来源范围", exact: true }).click();
    await panel.getByTestId("export-preview").getByText(/来源：本机可恢复数据/).waitFor();
    await panel.getByText("本机可恢复数据，不代表统一位置最新全量状态。", { exact: true }).waitFor();
    await page.screenshot({ path: ".build/mcp-export-scope.png", fullPage: true });
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
