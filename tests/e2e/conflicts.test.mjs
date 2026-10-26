import { startWorkspaceServer } from "@workspace/server/initialization";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron } from "playwright-core";
import { SqliteLocalStore } from "@workspace/adapters";
import { ConflictService } from "@workspace/core";
import { todoConflictPolicy } from "@workspace/todo-list";

const require = createRequire(import.meta.url);
test("N29–N30 real conflict entry, autosaved drafts, failed validation, offline submission, restart and deletion choices", { timeout: 120000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-conflict-window-"));
  const env = { ...process.env, WORKSPACE_CLIENT_DIRECTORY: directory, WORKSPACE_SETUP_HIDDEN: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => _electron.launch({ executablePath: require("electron"), args: ["apps/desktop/dist/host/workspace-main.js"], env });
  let application;
  let binding;
  const token = "offline-conflict-owner-credential-0123456789";
  let server = await startWorkspaceServer({ directory: join(directory, "authority"), token });
  async function withStore(run) {
    const store = await SqliteLocalStore.open({ databasePath: binding.replicaPath });
    try { return await run(store); } finally { await store.close(); }
  }
  let taskId;
  const readConflict = () => withStore((store) => store.readConflict({ workspaceId: binding.workspace.workspaceId, domainId: "builtin.todo", recordId: taskId }));
  try {
    application = await launch();
    let page = await application.firstWindow();
    await page.getByRole("button", { name: "创建新工作空间", exact: true }).click();
    await page.getByLabel("统一位置", { exact: true }).selectOption("remote");
    await page.getByLabel("服务器地址", { exact: true }).fill(server.url);
    await page.getByLabel("所有者接入凭据", { exact: true }).fill(token);
    await page.getByRole("button", { name: "确认创建", exact: true }).click();
    await page.getByLabel("任务内容", { exact: true }).fill("本机成果");
    await page.getByRole("button", { name: "添加待办", exact: true }).click();
    await page.getByTestId("captured-todo").getByText("本机成果", { exact: true }).waitFor();
    await page.evaluate(() => window.workspaceSetup.sync("now"));
    await server.close(); server = undefined;
    binding = JSON.parse(readFileSync(join(directory, "binding.json"), "utf8"));
    await withStore(async (store) => {
      const [record] = await store.listRecords({ workspaceId: binding.workspace.workspaceId, domainId: "builtin.todo" });
      taskId = record.recordId;
      await new ConflictService(store, todoConflictPolicy).retain({ ...record,
        base: { revision: 1, value: { ...record.payload, text: "共同进度" } },
        local: { baseRevision: 1, value: record.payload, changed: ["text"] },
        remote: { revision: 2, value: { ...record.payload, text: "统一位置成果" } }, remoteChanged: ["text"],
      }, record.localSequence);
    });
    await page.getByRole("button", { name: "重新读取冲突", exact: true }).click();
    await page.getByRole("button", { name: "处理冲突", exact: true }).click();
    let details = page.getByTestId("conflict-details");
    await details.getByRole("heading", { name: "同一条内容的差异", exact: true }).waitFor();
    assert.equal(await page.getByTestId("captured-todo").getByRole("checkbox").isDisabled(), true);
    await details.getByRole("button", { name: "手动整理", exact: true }).click();
    const editor = () => details.getByLabel("整理任务内容", { exact: true });
    await editor().fill("暂存后重开仍能继续");
    await page.getByTestId("conflict-status").getByText(/整理内容已保存在本机/).waitFor();
    await details.getByRole("button", { name: "稍后处理", exact: true }).click();
    assert.equal((await readConflict()).draft.value.text, "暂存后重开仍能继续");
    await application.close(); application = await launch(); page = await application.firstWindow();
    await page.getByRole("button", { name: "处理冲突", exact: true }).click();
    details = page.getByTestId("conflict-details");
    assert.equal(await editor().inputValue(), "暂存后重开仍能继续");
    await editor().fill(" ");
    await details.getByRole("button", { name: "明确保存解决结果", exact: true }).click();
    await page.getByTestId("conflict-status").getByText(/待办选择无效/).waitFor();
    assert.equal(await editor().isEditable(), true);
    const failedDraft = new DatabaseSync(binding.replicaPath);
    try { failedDraft.exec("CREATE TRIGGER fail_draft BEFORE UPDATE ON retained_conflicts BEGIN SELECT RAISE(ABORT,'draft failure'); END"); }
    finally { failedDraft.close(); }
    await editor().fill("保存失败也保留整理");
    await page.getByTestId("conflict-status").getByText(/选择保存失败/).waitFor();
    await details.getByRole("button", { name: "稍后处理", exact: true }).click();
    await page.getByTestId("conflict-status").getByText(/选择保存失败/).waitFor();
    assert.equal(await editor().inputValue(), "保存失败也保留整理");
    assert.equal(await details.isVisible(), true);
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "稍后处理" && !button.disabled));
    const repairedDraft = new DatabaseSync(binding.replicaPath);
    try { repairedDraft.exec("DROP TRIGGER fail_draft"); } finally { repairedDraft.close(); }
    await editor().fill("最终整理成果");
    await details.getByRole("button", { name: "明确保存解决结果", exact: true }).click();
    await page.getByTestId("conflict-status").getByText(/选择已保存在本机，待统一位置确认/).waitFor();
    assert.equal((await readConflict()).status, "pending");
    assert.equal(await editor().isEditable(), false);
    await page.screenshot({ path: ".build/conflict-resolution.png" });
    await details.getByRole("button", { name: "稍后处理", exact: true }).click();
    // Independent new content remains usable while one record is in conflict.
    await page.getByLabel("任务内容", { exact: true }).fill("其他内容正常处理");
    await page.getByRole("button", { name: "添加待办", exact: true }).click();
    await page.getByTestId("captured-todo").getByText("其他内容正常处理", { exact: true }).waitFor();
    const deleteId = "deleted-conflict";
    await withStore(async (store) => {
      const scope = { workspaceId: binding.workspace.workspaceId, domainId: "builtin.todo", recordId: deleteId };
      const payload = { text: "删除与编辑的成果", completed: false, createdAt: "2026-10-25T00:00:00Z" };
      const seq = await store.commit({ ...scope, operationId: "deleted", kind: "delete", payloadJson: null });
      await new ConflictService(store, todoConflictPolicy).retain({ ...scope, base: { revision: 1, value: { ...payload, text: "原任务" } },
        local: { baseRevision: 1, value: null, changed: [] }, remote: { revision: 2, value: payload }, remoteChanged: ["text"] }, seq);
    });
    await page.getByRole("button", { name: "重新读取冲突", exact: true }).click();
    await page.getByTestId("conflict-panel").getByText(/删除与编辑的成果 · 待处理/).locator("..").getByRole("button", { name: "处理冲突", exact: true }).click();
    await details.getByRole("button", { name: "恢复原内容并采用编辑结果", exact: true }).waitFor();
    assert.equal(await details.getByRole("button", { name: "明确保存解决结果", exact: true }).isDisabled(), true);
    await details.getByRole("button", { name: "保留删除", exact: true }).click();
    await details.getByRole("button", { name: "明确保存解决结果", exact: true }).click();
    await page.getByTestId("conflict-status").getByText(/选择已保存在本机，待统一位置确认/).waitFor();
    const db = new DatabaseSync(binding.replicaPath);
    try {
      assert.equal(db.prepare("SELECT deleted FROM local_records WHERE record_id=?").get(deleteId).deleted, 1);
      assert.equal(db.prepare("SELECT count(*) AS count FROM local_records WHERE domain_id='builtin.todo'").get().count, 3);
    } finally { db.close(); }
  } finally {
    if (application) await application.close();
    if (server) await server.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.split(/[/\\]/).at(-1)?.startsWith("workspace-conflict-window-"));
    rmSync(directory, { recursive: true, force: true });
  }
});
