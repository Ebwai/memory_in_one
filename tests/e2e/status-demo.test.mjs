import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron } from "playwright-core";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);

function useDatabase(path, query, parameters = []) {
  const db = new DatabaseSync(path);
  try { return db.prepare(query).all(...parameters); } finally { db.close(); }
}

function executeDatabase(path, sql) {
  const db = new DatabaseSync(path);
  try { db.exec(sql); } finally { db.close(); }
}

test("real Electron status UI preserves drafts, reloads saved content and isolates its host", { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-status-ui-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({ executablePath: require("electron"),
    args: ["apps/desktop/dist/host/main.js"], cwd: process.cwd(), timeout: 25000,
    env: { ...env, WORKSPACE_STATUS_DATA: join(directory, "workspace.sqlite"), WORKSPACE_STATUS_HIDDEN: "1" } });
  try {
    const page = await application.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const draft = page.getByLabel("当前内容", { exact: true });
    const save = page.getByRole("button", { name: "保存到本机", exact: true });
    const current = page.getByTestId("current-status");
    await page.waitForFunction(() => !document.querySelector("textarea")?.disabled);
    await current.getByText("未保存", { exact: true }).waitFor();
    await draft.fill("真实保存：先留下想法，再继续推进。");
    await save.click();
    await current.getByText("已保存在本机，待同步", { exact: true }).waitFor();
    assert.equal(await draft.inputValue(), "");
    await page.getByTestId("saved-content").getByText("真实保存：先留下想法，再继续推进。", { exact: true }).waitFor();
    await page.reload();
    await current.getByText("已保存在本机，待同步", { exact: true }).waitFor();
    assert.match(await page.getByTestId("saved-content").innerText(), /真实保存/);
    const security = await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process,
      methods: Object.keys(window.statusDemo).sort() }));
    assert.deepEqual(security, { require: "undefined", process: "undefined", methods: ["load", "recover", "save"] });
    mkdirSync(".build", { recursive: true });
    await page.screenshot({ path: ".build/status-demo.png", fullPage: true, timeout: 8000 });

    // Replace only the transport in this test process; production code has no fault switches.
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("status-demo:save");
      ipcMain.handle("status-demo:save", (_event, input) => new Promise((resolveReply) => {
        globalThis.finishStatusTestReply = () => resolveReply({ status: "saved-local", operationId: input.operationId, localSequence: 100 });
      }));
    });
    await draft.fill("较早提交");
    await save.click();
    await current.getByText("本机保存中", { exact: true }).waitFor();
    await draft.fill("在等待期间开始的新草稿");
    await application.evaluate(() => globalThis.finishStatusTestReply());
    await page.waitForFunction(() => ![...document.querySelectorAll("button")].find((button) => button.textContent === "保存到本机")?.disabled);
    assert.equal(await draft.inputValue(), "在等待期间开始的新草稿");
    await current.getByText("未保存", { exact: true }).waitFor();

    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("status-demo:save");
      ipcMain.handle("status-demo:save", () => ({ status: "not-saved", reason: "storage-unavailable", message: "Write rejected" }));
    });
    await save.click();
    await current.getByText("本机保存失败", { exact: true }).waitFor();
    assert.equal(await draft.inputValue(), "在等待期间开始的新草稿");
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("status-demo:save");
      ipcMain.handle("status-demo:save", (_event, input) => ({ status: "save-unconfirmed", operationId: input.operationId, message: "Reply unavailable" }));
    });
    await current.getByRole("button", { name: "重新保存", exact: true }).click();
    await current.getByText("结果待确认", { exact: true }).waitFor();
    assert.equal(await draft.inputValue(), "在等待期间开始的新草稿");
    assert.equal(await draft.isDisabled(), true);
    await current.getByRole("button", { name: "核对结果", exact: true }).click();
    await current.getByText("结果待确认", { exact: true }).waitFor();
    assert.equal(await draft.inputValue(), "在等待期间开始的新草稿");
    assert.match(await page.getByTestId("saved-content").innerText(), /真实保存/);
    const loaded = await page.evaluate(() => window.statusDemo.load());
    await application.evaluate(({ ipcMain }, snapshot) => {
      let calls = 0;
      let reportStarted;
      globalThis.oldStatusReadStarted = new Promise((resolveStarted) => { reportStarted = resolveStarted; });
      ipcMain.removeHandler("status-demo:load");
      ipcMain.handle("status-demo:load", () => {
        if (++calls === 1) return new Promise((_resolve, reject) => {
          globalThis.rejectOldStatusRead = () => reject(new Error("outdated read failure"));
          reportStarted();
        });
        return { ...snapshot, record: { ...snapshot.record, payload: { text: "真实保存：最新读取结果" } } };
      });
    }, loaded);
    await page.getByRole("button", { name: "重新读取", exact: true }).click();
    await application.evaluate(() => globalThis.oldStatusReadStarted);
    await page.getByRole("button", { name: "重新读取", exact: true }).click();
    await page.getByTestId("saved-content").getByText("真实保存：最新读取结果", { exact: true }).waitFor();
    await application.evaluate(() => globalThis.rejectOldStatusRead());
    // Allow the old IPC rejection to arrive before checking that it was ignored.
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.equal(await page.getByTestId("saved-content").innerText(), "真实保存：最新读取结果");
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("status-demo:load");
      ipcMain.handle("status-demo:load", () => ({ ok: false, message: "本机读取暂时不可用。" }));
    });
    await page.getByRole("button", { name: "重新读取", exact: true }).click();
    await page.getByRole("alert").getByText("本机读取暂时不可用。", { exact: true }).waitFor();
    assert.match(await page.getByTestId("saved-content").innerText(), /真实保存/);
    await page.reload();
    await page.getByTestId("saved-content").getByText("本机内容暂时无法读取", { exact: true }).waitFor();
    assert.doesNotMatch(await page.getByTestId("saved-content").innerText(), /还没有/);
    assert.deepEqual(errors, []);
  } finally {
    await application.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.split(/[/\\]/).at(-1)?.startsWith("workspace-status-ui-"));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real database failure retries the original operation and survives a full application restart", { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-reliable-window-"));
  const databasePath = join(directory, "workspace.sqlite");
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => _electron.launch({ executablePath: require("electron"), args: ["apps/desktop/dist/host/main.js"],
    cwd: process.cwd(), timeout: 25000, env: { ...env, WORKSPACE_STATUS_DATA: databasePath, WORKSPACE_STATUS_HIDDEN: "1" } });
  let application;
  try {
    application = await launch();
    let page = await application.firstWindow();
    await page.waitForFunction(() => !document.querySelector("textarea")?.disabled);
    const draft = page.getByLabel("当前内容", { exact: true });
    const save = page.getByRole("button", { name: "保存到本机", exact: true });
    const current = page.getByTestId("current-status");
    await draft.fill("最初完整保存的成果");
    await save.click();
    await current.getByText("已保存在本机，待同步", { exact: true }).waitFor();
    assert.equal(useDatabase(databasePath, "SELECT count(*) AS count FROM pending_operations")[0].count, 1);

    executeDatabase(databasePath, "CREATE TRIGGER reject_ui_write BEFORE UPDATE ON local_records BEGIN SELECT RAISE(ABORT, 'test disk rejection'); END;");
    await draft.fill("修复后沿原操作保存的新成果");
    const operationId = await current.locator("[data-operation-id]").getAttribute("data-operation-id");
    await save.click();
    await current.getByText("本机保存失败", { exact: true }).waitFor();
    assert.equal(await draft.inputValue(), "修复后沿原操作保存的新成果");
    assert.match(await page.getByTestId("saved-content").innerText(), /最初完整保存/);
    assert.equal(useDatabase(databasePath, "SELECT count(*) AS count FROM pending_operations")[0].count, 1);
    assert.equal(useDatabase(databasePath, "SELECT count(*) AS count FROM pending_operations WHERE operation_id = ?", [operationId])[0].count, 0);

    executeDatabase(databasePath, "DROP TRIGGER reject_ui_write;");
    await current.getByRole("button", { name: "重新保存", exact: true }).click();
    await current.getByText("已保存在本机，待同步", { exact: true }).waitFor();
    assert.equal(await draft.inputValue(), "");
    await page.getByTestId("saved-content").getByText("修复后沿原操作保存的新成果", { exact: true }).waitFor();
    assert.equal(useDatabase(databasePath, "SELECT count(*) AS count FROM pending_operations WHERE operation_id = ?", [operationId])[0].count, 1);
    assert.equal(useDatabase(databasePath, "SELECT count(*) AS count FROM pending_operations")[0].count, 2);
    await application.close();
    application = undefined;

    application = await launch();
    page = await application.firstWindow();
    await page.getByTestId("saved-content").getByText("修复后沿原操作保存的新成果", { exact: true }).waitFor();
    await page.getByTestId("current-status").getByText("已保存在本机，待同步", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("当前内容", { exact: true }).inputValue(), "");
    assert.equal(useDatabase(databasePath, "SELECT count(*) AS count FROM pending_operations")[0].count, 2);
  } finally {
    if (application) await application.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.split(/[/\\]/).at(-1)?.startsWith("workspace-reliable-window-"));
    rmSync(directory, { recursive: true, force: true });
  }
});
