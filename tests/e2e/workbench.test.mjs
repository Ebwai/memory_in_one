import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron } from "playwright-core";
const require = createRequire(import.meta.url);

test("N07–N10 extension registration, lifecycle, drafts and independent domain view", { timeout: 90000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-workbench-"));
  const env = { ...process.env, WORKSPACE_CLIENT_DIRECTORY: directory, WORKSPACE_SETUP_HIDDEN: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  let application;
  try {
    application = await _electron.launch({ executablePath: require("electron"), args: ["apps/desktop/dist/host/workspace-main.js"], env });
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "创建新工作空间", exact: true }).click();
    await page.getByRole("button", { name: "确认创建", exact: true }).click();
    await page.getByRole("button", { name: "工作空间管理", exact: true }).click();
    await page.getByTestId("domain-manager").waitFor();
    const source = readFileSync("extensions/sample-independent-domain/extension.json", "utf8");
    async function register() {
      await page.getByLabel("扩展 JSON", { exact: true }).fill(source);
      await page.getByRole("button", { name: "校验并查看扩展", exact: true }).click();
      await page.getByTestId("extension-preview").waitFor();
      await page.getByRole("button", { name: "确认注册或补齐程序", exact: true }).click();
      await page.getByTestId("extension-preview").waitFor({ state: "detached" });
    }
    await register();
    const domain = page.getByTestId("domain-example.reading");
    assert.equal(await domain.getByRole("button", { name: "进入领域", exact: true }).isDisabled(), true);
    await domain.getByRole("button", { name: "启用", exact: true }).click();
    await page.getByRole("button", { name: "确认启用", exact: true }).click();
    await domain.getByRole("button", { name: "进入领域", exact: true }).click();
    const view = page.getByTestId("domain-view");
    await view.getByLabel("quote", { exact: true }).fill("保留这段摘录");
    await view.getByLabel("book", { exact: true }).fill("独立的书籍字段");
    await domain.getByRole("button", { name: "停用", exact: true }).click();
    await page.getByRole("button", { name: "确认停用", exact: true }).click();
    await page.getByRole("button", { name: "取消操作", exact: true }).click();
    assert.equal(await view.getByLabel("quote", { exact: true }).inputValue(), "保留这段摘录");
    await page.getByRole("button", { name: "确认停用", exact: true }).click();
    await page.getByRole("button", { name: "保存后继续", exact: true }).click();
    await view.waitFor({ state: "detached" });
    await domain.getByRole("button", { name: "移除本机程序", exact: true }).click();
    await page.getByRole("button", { name: "确认移除本机程序", exact: true }).click();
    await domain.getByText(/缺少本机程序/).waitFor();
    await register();
    await domain.getByRole("button", { name: "启用", exact: true }).click();
    await page.getByRole("button", { name: "确认启用", exact: true }).click();
    await domain.getByRole("button", { name: "进入领域", exact: true }).click();
    await view.getByText("保留这段摘录", { exact: true }).waitFor();
    const pending = JSON.parse(readFileSync(join(directory, "binding.json"), "utf8"));
    assert.ok(pending.replicaPath);
    const { DatabaseSync } = await import("node:sqlite");
    const beforeReview = new DatabaseSync(pending.replicaPath, { readOnly: true });
    const countBeforeReview = beforeReview.prepare("SELECT count(*) AS count FROM pending_operations").get().count;
    beforeReview.close();
    await view.getByRole("button", { name: "编辑", exact: true }).click();
    assert.equal(await view.getByLabel("quote", { exact: true }).inputValue(), "保留这段摘录");
    assert.equal(await view.getByLabel("book", { exact: true }).inputValue(), "独立的书籍字段");
    assert.equal(await view.getByRole("checkbox").count(), 0);
    assert.equal(await view.getByText(/截止日期|已完成区/).count(), 0);
    const afterReview = new DatabaseSync(pending.replicaPath, { readOnly: true });
    assert.equal(afterReview.prepare("SELECT count(*) AS count FROM pending_operations").get().count, countBeforeReview);
    afterReview.close();
  } finally {
    if (application) await application.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.split(/[/\\]/).at(-1)?.startsWith("workspace-workbench-"));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("N11–N15 floating capture handles IME, paste, repeat intent, real failure and restart", { timeout: 90000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-workbench-"));
  const env = { ...process.env, WORKSPACE_CLIENT_DIRECTORY: directory, WORKSPACE_SETUP_HIDDEN: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  let application;
  async function launch() {
    const launched=await _electron.launch({ executablePath: require("electron"), args: ["apps/desktop/dist/host/workspace-main.js"], env });
    // Native topmost state is only meaningful for a shown Windows window.
    await launched.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());
    return launched;
  }
  try {
    application = await launch();
    let page = await application.firstWindow();
    await page.getByRole("button", { name: "创建新工作空间", exact: true }).click();
    await page.getByRole("button", { name: "确认创建", exact: true }).click();
    await page.getByTestId("todo-capture").waitFor();
    const input = page.getByLabel("任务内容", { exact: true });
    assert.equal(await application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window.isAlwaysOnTop()) return true;
      return new Promise(resolve => {
        const poll=setInterval(()=>{if(window.isAlwaysOnTop()){clearInterval(poll);clearTimeout(timer);resolve(true);}},20);
        const timer=setTimeout(()=>{clearInterval(poll);resolve(window.isAlwaysOnTop());},5000);
      });
    }), true);
    await input.fill("窗口移动不丢草稿");
    await page.getByRole("button", { name: "取消置顶", exact: true }).click();
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()), false);
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const [x, y] = window.getPosition(); window.setPosition(x + 30, y + 20);
    });
    assert.equal(await input.inputValue(), "窗口移动不丢草稿");
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await page.getByRole("button", { name: "取消操作", exact: true }).click();
    assert.equal(await input.inputValue(), "窗口移动不丢草稿");
    await page.getByRole("button", { name: "窗口置顶", exact: true }).click();
    await input.fill("  ");
    await page.getByRole("button", { name: "添加待办", exact: true }).click();
    await page.getByTestId("todo-save-status").getByText(/请填写任务内容/).waitFor();
    assert.equal(await input.inputValue(), "  ");
    assert.equal(await page.getByTestId("captured-todo").count(), 0);
    await input.fill("中文选词");
    await input.dispatchEvent("compositionstart");
    await input.press("Enter");
    assert.equal(await page.getByTestId("captured-todo").count(), 0);
    await input.dispatchEvent("compositionend");
    await input.press("Enter");
    await page.getByTestId("captured-todo").getByText("中文选词", { exact: true }).waitFor();
    assert.equal(await input.inputValue(), "");
    assert.equal(await input.evaluate((element) => document.activeElement === element), true);
    const multiline = "买牛奶\n明天 [x] 仍是一条任务";
    await input.fill(multiline);
    await page.getByRole("button", { name: "添加待办", exact: true }).click();
    await page.getByTestId("captured-todo").getByText(multiline, { exact: true }).waitFor();
    assert.equal(await page.getByTestId("captured-todo").count(), 2);
    await input.fill("允许主动重复");
    await input.press("Enter");
    await page.getByTestId("todo-save-status").getByText("已保存在本机，待同步。", { exact: true }).waitFor();
    await input.fill("允许主动重复");
    await input.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="captured-todo"]').length === 4);
    const binding = JSON.parse(readFileSync(join(directory, "binding.json"), "utf8"));
    const { DatabaseSync } = await import("node:sqlite");
    let db = new DatabaseSync(binding.replicaPath);
    db.exec("CREATE TRIGGER injected_capture_failure BEFORE INSERT ON pending_operations WHEN NEW.domain_id = 'builtin.todo' BEGIN SELECT RAISE(ABORT, 'test save failure'); END");
    db.close();
    await input.fill("失败后保留中文");
    await page.getByRole("button", { name: "添加待办", exact: true }).click();
    await page.getByTestId("todo-save-status").getByText(/未能|无法|未保存|失败|不能/).waitFor();
    assert.equal(await input.inputValue(), "失败后保留中文");
    assert.equal(await page.getByTestId("captured-todo").count(), 4);
    db = new DatabaseSync(binding.replicaPath);
    db.exec("DROP TRIGGER injected_capture_failure"); db.close();
    await input.fill("修正后再保存");
    await page.getByRole("button", { name: "添加待办", exact: true }).click();
    await page.getByTestId("captured-todo").getByText("修正后再保存", { exact: true }).waitFor();
    await input.fill("离开前保留");
    await page.getByRole("button", { name: "工作空间管理", exact: true }).click();
    await page.getByRole("button", { name: "取消操作", exact: true }).click();
    assert.equal(await input.inputValue(), "离开前保留");
    await page.getByRole("button", { name: "工作空间管理", exact: true }).click();
    await page.getByRole("button", { name: "放弃输入并继续", exact: true }).click();
    const todo = page.getByTestId("domain-builtin.todo");
    assert.equal(await todo.getByRole("button", { name: "移除本机程序", exact: true }).count(), 0);
    await todo.getByRole("button", { name: "停用", exact: true }).click();
    await page.getByRole("button", { name: "确认停用", exact: true }).click();
    assert.equal(await todo.getByRole("button", { name: "进入领域", exact: true }).isDisabled(), true);
    await todo.getByRole("button", { name: "启用", exact: true }).click();
    await page.getByRole("button", { name: "确认启用", exact: true }).click();
    await todo.getByRole("button", { name: "进入领域", exact: true }).click();
    await page.getByTestId("captured-todo").getByText("修正后再保存", { exact: true }).waitFor();
    await page.screenshot({ path: ".build/todo-capture.png", fullPage: true });
    await application.close(); application = undefined;
    application = await launch();
    page = await application.firstWindow();
    await page.getByTestId("todo-capture").waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="captured-todo"]').length === 5);
    assert.equal(await application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window.isAlwaysOnTop()) return true;
      return new Promise(resolve => {
        const poll=setInterval(()=>{if(window.isAlwaysOnTop()){clearInterval(poll);clearTimeout(timer);resolve(true);}},20);
        const timer=setTimeout(()=>{clearInterval(poll);resolve(window.isAlwaysOnTop());},5000);
      });
    }), true);
    const pendingDb = new DatabaseSync(binding.replicaPath, { readOnly: true });
    const count = pendingDb.prepare("SELECT count(*) AS count FROM pending_operations WHERE domain_id = 'builtin.todo'").get();
    assert.equal(count.count, 5); pendingDb.close();
  } finally {
    if (application) await application.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.split(/[/\\]/).at(-1)?.startsWith("workspace-workbench-"));
    rmSync(directory, { recursive: true, force: true });
  }
});
