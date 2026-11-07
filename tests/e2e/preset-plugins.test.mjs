import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron } from "playwright-core";
const require = createRequire(import.meta.url);

test("project templates and fixed notes support editing, completion, deletion and restart", { timeout: 120000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "preset-plugins-ui-"));
  const env = { ...process.env, WORKSPACE_CLIENT_DIRECTORY: directory, WORKSPACE_SETUP_HIDDEN: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  async function launch() { app = await _electron.launch({ executablePath: require("electron"), args: ["apps/desktop/dist/host/workspace-main.js"], env }); return app.firstWindow(); }
  try {
    let page = await launch();
    await page.getByRole("button", { name: "创建新工作空间", exact: true }).click();
    await page.getByRole("button", { name: "确认创建", exact: true }).click();
    await page.getByRole("button",{name:"返回主页",exact:false}).click();
    await page.getByRole("button", { name: "工作空间", exact: true }).click();
    const notes = () => page.getByTestId("domain-preset.notes");
    await notes().waitFor();
    await page.getByText("＋ 新增插件", { exact: true }).click();
    await page.getByRole("button", { name: "按模板新建插件", exact: true }).click();
    for (let i = 0; i < 2; i++) {
      await page.getByLabel("项目名称", { exact: true }).fill("装修项目");
      await page.getByRole("button", { name: "创建项目插件", exact: true }).click();
      await page.getByLabel("项目名称", { exact: true }).filter({ visible: true }).waitFor();
      await page.waitForFunction(n => document.querySelectorAll('[data-testid^="domain-preset.project."]').length === n, i + 1);
    }
    const projects = () => page.locator('[data-testid^="domain-preset.project."]');
    await projects().first().getByRole("button", { name: "进入领域", exact: true }).click();
    const view = () => page.getByTestId("domain-view");
    await view().waitFor();
    assert.equal(await page.locator("[data-testid=domain-manager]>article").count(), 0);
    assert.equal(await page.locator(".plugin-add-actions").count(), 0);
    async function save(label, text) { await view().getByLabel(label, { exact: true }).fill(text); await view().getByRole("button", { name: "保存领域内容", exact: true }).click(); await page.waitForFunction(label => document.querySelector(`textarea[aria-label="${label}"]`)?.value === "", label); await view().locator("li").getByText(text, { exact: true }).waitFor(); }
    await save("想法内容", "先看设计方案");
    await view().getByRole("button", { name: "项目待办", exact: true }).click();
    await save("待办内容", "联系施工团队");
    await view().getByRole("checkbox", { name: "完成", exact: true }).click();
    await view().getByRole("checkbox", { name: "恢复为未完成", exact: true }).waitFor();
    await view().getByRole("checkbox", { name: "恢复为未完成", exact: true }).click();
    await view().getByRole("checkbox", { name: "完成", exact: true }).waitFor();
    await page.getByRole("button", { name: "返回领域目录", exact: true }).click();
    await notes().getByRole("button", { name: "进入领域", exact: true }).click();
    await save("随记内容", "独立的一点灵感");
    assert.equal(await view().getByText("联系施工团队", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "返回领域目录", exact: true }).click();
    await projects().first().getByRole("button", { name: "重命名项目", exact: true }).click();
    await page.getByLabel("新项目名称", { exact: true }).fill("装修计划");
    await page.getByRole("button", { name: "保存项目名称", exact: true }).click();
    await page.getByRole("heading", { name: "装修计划", exact: true }).waitFor();
    await app.close(); app = null; page = await launch(); await page.getByRole("button",{name:"返回主页",exact:false}).click();
    await page.getByRole("button", { name: "工作空间", exact: true }).click();
    await page.getByRole("heading", { name: "装修计划", exact: true }).waitFor();
    await projects().first().getByRole("button", { name: "删除项目", exact: true }).click();
    await page.getByRole("button", { name: "取消项目操作", exact: true }).click();
    assert.equal(await projects().count(), 2);
    await projects().first().getByRole("button", { name: "删除项目", exact: true }).click();
    await page.getByRole("button", { name: "确认删除整个项目", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="domain-preset.project."]').length === 1);
    await notes().getByRole("button", { name: "进入领域", exact: true }).click();
    await view().getByText("独立的一点灵感", { exact: true }).waitFor();
    await view().locator(".domain-record-content").dblclick();
    await view().getByLabel("修改内容", {exact:true}).fill("修改后的灵感"); await view().getByLabel("修改内容", {exact:true}).press("Enter");
    await view().locator(".domain-record-content").getByText("修改后的灵感",{exact:true}).waitFor();
    await view().getByRole("button", { name: "删除", exact: true }).click();
    await view().getByRole("button", { name: "取消删除", exact: true }).click();
    await view().locator("li").getByText("修改后的灵感", { exact: true }).waitFor();
    await view().getByRole("button", { name: "删除", exact: true }).click();
    await view().getByRole("button", { name: "确认删除此内容", exact: true }).click();
    await view().locator("li").getByText("修改后的灵感", { exact: true }).waitFor({ state: "detached" });
  } finally { if (app) await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
