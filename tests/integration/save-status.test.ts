import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LocalContentService } from "@workspace/core";
import { SqliteLocalStore } from "@workspace/adapters";
import { SaveStatus, applyLocalResult, applySyncStatus, createSaveStatus, projectSaveStatus, restoreLocalStatus, startLocalSave } from "@workspace/ui";
import type { OperationReference } from "@workspace/contracts";
import type { SaveStatusState } from "@workspace/ui";

const reference = { workspaceId: "space", domainId: "notes", recordId: "record", operationId: "current-op" };
const saved = { status: "saved-local" as const, operationId: reference.operationId, localSequence: 4 };
const pending = (): SaveStatusState => applyLocalResult(startLocalSave(createSaveStatus(reference)), reference, saved);
const syncEvent = (phase: "syncing" | "synced" | "sync-failed" | "sync-unconfirmed" | "conflict", attempt = 1) =>
  ({ ...reference, localSequence: 4, phase, attempt });

test("local save moves through saving to pending without claiming network synchronization", () => {
  const initial = createSaveStatus(reference);
  assert.equal(projectSaveStatus(initial).localSaved, false);
  const saving = startLocalSave(initial);
  assert.equal(projectSaveStatus(saving).title, "本机保存中");
  assert.equal(projectSaveStatus(saving).localSaved, false);
  const state = applyLocalResult(saving, reference, saved);
  assert.equal(state.phase, "pending");
  assert.equal(projectSaveStatus(state).title, "已保存在本机，待同步");
  assert.equal(projectSaveStatus(state).localSaved, true);
});

test("save failure and uncertain result preserve their distinct next actions", () => {
  const saving = startLocalSave(createSaveStatus(reference));
  const failed = applyLocalResult(saving, reference, { status: "not-saved", reason: "storage-unavailable", message: "failure" });
  const unknown = applyLocalResult(saving, reference, { status: "save-unconfirmed", operationId: reference.operationId, message: "unknown" });
  assert.equal(projectSaveStatus(failed).action, "retry-local");
  assert.equal(projectSaveStatus(unknown).action, "check-result");
  assert.equal(projectSaveStatus(unknown).localSaved, false);
  assert.equal(startLocalSave(unknown), unknown);
});

test("results for an older draft or a different identity cannot change the current draft", () => {
  const references: OperationReference[] = [{ ...reference, operationId: "new-draft" }, { ...reference, recordId: "other" },
    { ...reference, domainId: "other" }, { ...reference, workspaceId: "other" }];
  for (const current of references) {
    const state = startLocalSave(createSaveStatus(current));
    assert.equal(applyLocalResult(state, reference, saved), state);
  }
});

test("a mismatched result or invalid sequence cannot fabricate local success", () => {
  const state = startLocalSave(createSaveStatus(reference));
  assert.equal(applyLocalResult(state, reference, { ...saved, operationId: "wrong" }), state);
  assert.equal(applyLocalResult(state, reference, { ...saved, localSequence: -1 }).phase, "local-unconfirmed");
  assert.throws(() => restoreLocalStatus({ ...reference, kind: "put", payloadJson: "{}", localSequence: 0 }));
});

test("recovering an uncertain local result can confirm pending without reporting synced", () => {
  const unknown = applyLocalResult(startLocalSave(createSaveStatus(reference)), reference,
    { status: "save-unconfirmed", operationId: reference.operationId, message: "unknown" });
  assert.equal(applyLocalResult(unknown, reference, saved).phase, "pending");
});

test("sync status needs the current operation, confirmed local sequence and valid attempt", () => {
  const state = pending();
  for (const event of [{ ...syncEvent("synced"), operationId: "old" }, { ...syncEvent("synced"), localSequence: 3 },
    syncEvent("synced", 0), { ...syncEvent("synced"), recordId: "other" }]) assert.equal(applySyncStatus(state, event), state);
  const unsaved = createSaveStatus(reference);
  assert.equal(applySyncStatus(unsaved, syncEvent("synced")), unsaved);
  assert.equal(applySyncStatus(state, syncEvent("synced")).phase, "synced");
});

test("late sync failures and progress cannot reverse a newer confirmed attempt", () => {
  let state = applySyncStatus(pending(), syncEvent("syncing", 1));
  state = applySyncStatus(state, syncEvent("synced", 2));
  assert.equal(applySyncStatus(state, syncEvent("sync-failed", 1)), state);
  assert.equal(applySyncStatus(state, syncEvent("syncing", 2)), state);
  assert.equal(applySyncStatus(state, syncEvent("sync-failed", 2)), state);
});

test("a new edit has no inherited synchronization claim from the previous operation", () => {
  const prior = applySyncStatus(pending(), syncEvent("synced"));
  const draft = createSaveStatus({ ...reference, operationId: "next-edit" });
  assert.equal(applySyncStatus(draft, syncEvent("synced")), draft);
  assert.equal(draft.phase, "unsaved");
  assert.equal(draft.localSequence, null);
  assert.equal(prior.phase, "synced");
});

test("sync failure retains local saved meaning and does not ask for repeated data entry", () => {
  const state = applySyncStatus(pending(), syncEvent("sync-failed"));
  const view = projectSaveStatus(state);
  assert.equal(view.title, "同步失败");
  assert.equal(view.localSaved, true);
  assert.match(view.detail, /无需重新输入/);
  assert.equal(view.action, "retry-sync");
});

test("local uncertainty differs from uncertainty about the unified location", () => {
  const local = applyLocalResult(startLocalSave(createSaveStatus(reference)), reference,
    { status: "save-unconfirmed", operationId: reference.operationId, message: "unknown" });
  const remote = applySyncStatus(pending(), syncEvent("sync-unconfirmed"));
  assert.equal(projectSaveStatus(local).localSaved, false);
  assert.equal(projectSaveStatus(remote).localSaved, true);
  assert.match(projectSaveStatus(remote).detail, /统一位置/);
});

test("rendered status has readable text and synced does not mean all devices updated", () => {
  const html = renderToStaticMarkup(createElement(SaveStatus, { state: applySyncStatus(pending(), syncEvent("synced")) }));
  assert.match(html, /已同步至统一位置/);
  assert.match(html, /不表示每台其他设备都已取得/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
});

test("handlers expose the correct next action without manufacturing a conflict solution", () => {
  const conflict = applySyncStatus(pending(), syncEvent("conflict"));
  const before = renderToStaticMarkup(createElement(SaveStatus, { state: conflict }));
  assert.match(before, /存在冲突，待处理/);
  assert.doesNotMatch(before, /<button/);
  const supplied = renderToStaticMarkup(createElement(SaveStatus, { state: conflict, onResolveConflict: () => {} }));
  assert.match(supplied, /处理冲突<\/button>/);
  assert.equal(conflict.phase, "conflict");
});

test("duplicate local replies cannot regress a state already confirmed by the unified location", () => {
  const state = applySyncStatus(pending(), syncEvent("synced"));
  assert.equal(applyLocalResult(state, reference, saved), state);
  assert.equal(applyLocalResult(state, reference, { status: "not-saved", reason: "storage-unavailable", message: "late" }), state);
});

test("restart presentation comes from the current durable receipt and remains pending", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-status-state-"));
  const databasePath = join(directory, "workspace.sqlite");
  let store = await SqliteLocalStore.open({ databasePath });
  try {
    const service = new LocalContentService(store);
    await service.save({ ...reference, operationId: "old-op", kind: "put", payload: { body: "old" } });
    await service.save({ ...reference, kind: "put", payload: { body: "new" } });
    await store.close();
    store = await SqliteLocalStore.open({ databasePath });
    const record = await store.readRecord(reference);
    const receipt = (await store.listPending(reference)).find((item) => item.localSequence === record?.localSequence);
    assert.ok(receipt);
    const state = restoreLocalStatus(receipt);
    assert.equal(state.operationId, reference.operationId);
    assert.equal(state.phase, "pending");
    assert.equal(projectSaveStatus(state).localSaved, true);
  } finally {
    await store.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.split(/[/\\]/).at(-1)?.startsWith("workspace-status-state-"));
    rmSync(directory, { recursive: true, force: true });
  }
});
