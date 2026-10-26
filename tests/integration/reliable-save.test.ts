import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteLocalStore } from "@workspace/adapters";
import { LocalContentService } from "@workspace/core";
import { applyLocalResult, createSaveStatus, projectSaveStatus, restoreLocalStatus, startLocalSave } from "@workspace/ui";
import type { LocalChange, LocalPersistence } from "@workspace/contracts";

const reference = { workspaceId: "space", domainId: "project-ideas", recordId: "idea", operationId: "first-action" };
const input: LocalChange = { ...reference, kind: "put", payload: { idea: "共同保存底座", nextThought: "稍后继续", milestones: [] } };

async function withStore(run: (context: { path: string; open: () => Promise<SqliteLocalStore> }) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "workspace-reliable-save-"));
  const stores: SqliteLocalStore[] = [];
  try {
    const path = join(directory, "workspace.sqlite");
    await run({ path, open: async () => {
      const store = await SqliteLocalStore.open({ databasePath: path });
      stores.push(store);
      return store;
    } });
  } finally {
    for (const store of stores) await store.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.split(/[/\\]/).at(-1)?.startsWith("workspace-reliable-save-"));
    rmSync(directory, { recursive: true, force: true });
  }
}

function executeSql(path: string, sql: string): void {
  const db = new DatabaseSync(path);
  try { db.exec(sql); } finally { db.close(); }
}

test("shared save package commits, presents pending and safely reuses a receipt across restart", async () => {
  await withStore(async ({ open }) => {
    let store = await open();
    let service = new LocalContentService(store);
    const saving = startLocalSave(createSaveStatus(input));
    assert.equal(projectSaveStatus(saving).localSaved, false);
    const result = await service.save(input);
    const displayed = applyLocalResult(saving, input, result);
    assert.equal(displayed.phase, "pending");
    assert.equal(projectSaveStatus(displayed).localSaved, true);
    assert.deepEqual((await store.readRecord(input))?.payload, input.kind === "put" ? input.payload : null);
    assert.equal((await store.listPending(input)).length, 1);
    await store.close();
    store = await open();
    service = new LocalContentService(store);
    const receipt = await store.readOperation(input);
    assert.ok(receipt);
    assert.equal(restoreLocalStatus(receipt).phase, "pending");
    assert.deepEqual(await service.recover(input), result);
    assert.deepEqual(await service.save(input), result);
    assert.equal((await store.listPending(input)).length, 1);
  });
});

test("real write rejection, state failure and original-action retry remain one consistent flow", async () => {
  await withStore(async ({ open, path }) => {
    const store = await open();
    const service = new LocalContentService(store);
    await service.save(input);
    const next: LocalChange = { ...reference, operationId: "retry-action", kind: "put", payload: { idea: "保留原成果再推进" } };
    executeSql(path, "CREATE TRIGGER reject_change BEFORE UPDATE ON local_records BEGIN SELECT RAISE(ABORT, 'test rejection'); END;");
    const failed = await service.save(next);
    const display = applyLocalResult(startLocalSave(createSaveStatus(next)), next, failed);
    assert.equal(projectSaveStatus(display).title, "本机保存失败");
    assert.equal(projectSaveStatus(display).localSaved, false);
    assert.equal(await store.readOperation(next), null);
    assert.deepEqual((await store.readRecord(input))?.payload, input.kind === "put" ? input.payload : null);
    executeSql(path, "DROP TRIGGER reject_change;");
    const saved = await service.save(next);
    assert.equal(applyLocalResult(startLocalSave(display), next, saved).phase, "pending");
    assert.deepEqual(await service.save(next), saved);
    assert.equal((await store.listPending(next)).length, 2);
  });
});

test("actual committed data with a lost response recovers without erasing a newer draft or replaying writes", async () => {
  await withStore(async ({ open }) => {
    const underlying = await open();
    const loss: LocalPersistence = {
      commit: async (change) => { await underlying.commit(change); throw new Error("lost acknowledgement"); },
      readOperation: (scope) => underlying.readOperation(scope),
      readRecord: (scope) => underlying.readRecord(scope),
      listRecords: (scope) => underlying.listRecords(scope),
      listPending: (scope) => underlying.listPending(scope),
      close: () => underlying.close(),
    };
    const unknownResult = await new LocalContentService(loss).save(input);
    const unknown = applyLocalResult(startLocalSave(createSaveStatus(input)), input, unknownResult);
    assert.equal(unknown.phase, "local-unconfirmed");
    assert.equal(projectSaveStatus(unknown).action, "check-result");
    assert.deepEqual((await underlying.readRecord(input))?.payload, input.kind === "put" ? input.payload : null);
    await underlying.close();
    const reopened = await open();
    const service = new LocalContentService(reopened);
    const confirmed = await service.recover(input);
    assert.equal(applyLocalResult(unknown, input, confirmed).phase, "pending");
    const newerDraft = createSaveStatus({ ...reference, operationId: "newer-draft" });
    assert.equal(applyLocalResult(newerDraft, input, confirmed), newerDraft);
    assert.deepEqual(await service.save(input), confirmed);
    assert.equal((await reopened.listPending(input)).length, 1);
  });
});

test("one shared save flow preserves unrelated domain models without introducing task fields", async () => {
  await withStore(async ({ open }) => {
    const store = await open();
    const service = new LocalContentService(store);
    const reading: LocalChange = { ...reference, domainId: "reading-notes", operationId: "reading-action", kind: "put",
      payload: { book: "读书记录", quotation: "独立内容", annotations: ["一段批注"] } };
    for (const change of [input, reading]) {
      const result = await service.save(change);
      assert.equal(applyLocalResult(startLocalSave(createSaveStatus(change)), change, result).phase, "pending");
      assert.deepEqual((await store.readRecord(change))?.payload, change.kind === "put" ? change.payload : null);
      assert.equal((await store.listPending(change)).length, 1);
    }
  });
});

