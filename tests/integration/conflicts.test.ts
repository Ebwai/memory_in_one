import { ConcurrentContent } from "@workspace/core";
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareContent } from "@workspace/core";
import { todoConflictPolicy, validateTodoConflict } from "@workspace/todo-list";
import type { Comparison, JsonObject } from "@workspace/contracts";
import { ConflictService } from "@workspace/core";
import type { ResolutionAuthority } from "@workspace/core";
import { SqliteLocalStore } from "@workspace/adapters";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

async function disk(run: (path: string, store: SqliteLocalStore) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "workspace-conflict-"));
  const path = join(directory, "replica.sqlite");
  const store = await SqliteLocalStore.open({ databasePath: path });
  try { await run(path, store); }
  finally {
    await store.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.split(/[/\\]/).at(-1)?.startsWith("workspace-conflict-"));
    await rm(directory, { force: true, recursive: true });
  }
}
async function seed(store: SqliteLocalStore, local: JsonObject | null = { ...original, text: "本机" }) {
  return store.commit({ ...scope, operationId: "initial", kind: local === null ? "delete" : "put", payloadJson: local === null ? null : JSON.stringify(local) });
}
const differing = () => comparison({ ...original, text: "本机" }, { ...original, text: "统一位置" });

const scope = { workspaceId: "space", domainId: "builtin.todo", recordId: "task" };
const original: JsonObject = { text: "原内容", createdAt: "2026-10-25T00:00:00Z", completed: false, dueDate: "2026-10-26" };
function comparison(local: JsonObject | null, remote: JsonObject | null): Comparison {
  return { ...scope, base: { revision: 1, value: original }, local: { baseRevision: 1, value: local, changed: [] },
    remote: { revision: 2, value: remote }, remoteChanged: [] };
}
test("N27 todo attributes, explicit date clearing, valid choices and completion history", () => {
  const local = { ...original, text: "本机" }; const remote = { ...original, dueDate: "2026-10-27" };
  assert.deepEqual(compareContent(comparison(local, remote), todoConflictPolicy), { status: "merged", value: { ...local, dueDate: remote.dueDate } });
  const cleared = { ...original }; delete cleared.dueDate;
  const withoutDate: JsonObject = { ...local }; delete withoutDate.dueDate;
  assert.deepEqual(compareContent(comparison(cleared, local), todoConflictPolicy), { status: "merged", value: withoutDate });
  const completed = { ...original, completed: true, completedAt: "2026-10-25T04:00:00Z" };
  assert.deepEqual(compareContent(comparison({ ...completed, completedAt: "2026-10-25T03:00:00Z" }, completed), todoConflictPolicy), { status: "merged", value: completed });
  const cycles = comparison(original, completed);
  assert.equal(compareContent({ ...cycles, local: { ...cycles.local, changed: ["completion"] } }, todoConflictPolicy).status, "conflict");
  for (const value of [{ ...original, text: " " }, { ...original, dueDate: "2026-02-30" }, { ...original, completedAt: "2026-10-25T03:00:00Z" }, { ...original, createdAt: "2026-10-24" }]) {
    assert.throws(() => validateTodoConflict(value, original));
  }
});
test("N28 shared comparison is conservative and never joins unrelated identities", () => {
  const input = comparison({ ...original, text: "甲" }, { ...original, text: "乙" });
  assert.equal(compareContent(input, todoConflictPolicy).status, "conflict");
  assert.equal(compareContent({ ...input, base: null }, todoConflictPolicy).status, "conflict");
  assert.equal(compareContent(input).status, "conflict");
  assert.equal(compareContent({ ...input, local: { ...input.local, baseRevision: 0 } }, todoConflictPolicy).status, "conflict");
  assert.deepEqual(compareContent(comparison(null, null), todoConflictPolicy), { status: "merged", value: null });
  assert.equal(compareContent(comparison(null, { ...original, text: "编辑" }), todoConflictPolicy).status, "conflict");
  assert.deepEqual(compareContent(comparison(null, original), todoConflictPolicy), { status: "merged", value: null });
  const same = { ...original, text: "相同" };
  assert.deepEqual(compareContent(comparison(same, same), todoConflictPolicy), { status: "merged", value: same });
});

test("N29 durable materials survive restart, block all ordinary writes, isolate other records and retain new remote progress", async () => disk(async (path, store) => {
  const sequence = await seed(store);
  const service = new ConflictService(store, todoConflictPolicy);
  const retained = await service.retain(differing(), sequence);
  await assert.rejects(store.commit({ ...scope, operationId: "bypass", kind: "put", payloadJson: JSON.stringify(original) }));
  await store.commit({ ...scope, recordId: "other", operationId: "other", kind: "put", payloadJson: JSON.stringify(original) });
  const draft = await service.saveChoice(scope, retained.generation, "draft", { kind: "manual", value: { ...original, text: "尚未提交的整理" } }, false);
  const updatedInput = { ...differing(), remote: { revision: 3, value: { ...original, text: "再次更新" } } };
  const updated = await service.retain(updatedInput, sequence);
  assert.deepEqual(updated.draft, draft.draft);
  assert.equal(updated.remoteHistory.length, 2);
  assert.deepEqual(await service.retain(updatedInput, sequence), updated);
  assert.deepEqual(await service.retain(differing(), sequence), updated);
  const reopened = await SqliteLocalStore.open({ databasePath: path });
  try {
    assert.deepEqual(await reopened.readConflict(scope), updated);
    assert.equal((await reopened.listConflicts(scope)).length, 1);
    assert.equal((await reopened.listConflicts({ ...scope, workspaceId: "other-space" })).length, 0);
    assert.equal((await reopened.listRecords(scope)).length, 2);
    assert.equal((await reopened.readRecord(scope))?.payload?.text, "本机");
  } finally { await reopened.close(); }
  await assert.rejects(service.saveChoice(scope, draft.generation, "stale", { kind: "local" }, true));
}));

test("N29 failed retention rolls back without covering content; CAS guards simultaneous decisions and local changes", async () => disk(async (path, store) => {
  const sequence = await seed(store);
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TRIGGER fail_retention BEFORE INSERT ON retained_conflicts BEGIN SELECT RAISE(ABORT,'failure'); END");
    await assert.rejects(new ConflictService(store, todoConflictPolicy).retain(differing(), sequence));
    assert.equal(await store.readConflict(scope), null);
    assert.equal((await store.readRecord(scope))?.payload?.text, "本机");
    db.exec("DROP TRIGGER fail_retention");
  } finally { db.close(); }
  await assert.rejects(new ConflictService(store, todoConflictPolicy).retain(differing(), sequence + 1));
  const service = new ConflictService(store, todoConflictPolicy);
  const conflict = await service.retain(differing(), sequence);
  const outcomes = await Promise.allSettled([
    service.saveChoice(scope, conflict.generation, "one", { kind: "local" }, false),
    service.saveChoice(scope, conflict.generation, "two", { kind: "remote" }, false),
  ]);
  assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
}));

test("N30 each explicit editing choice waits offline, accepts only authority confirmation and preserves original identity", async () => {
  for (const choice of [{ kind: "local" as const }, { kind: "remote" as const }, { kind: "manual" as const, value: { ...original, text: "整理" } }]) {
    await disk(async (_path, store) => {
      const sequence = await seed(store);
      const service = new ConflictService(store, todoConflictPolicy);
      const conflict = await service.retain(differing(), sequence);
      const saved = await service.saveChoice(scope, conflict.generation, "resolve", choice, true);
      assert.equal(await service.submit(scope), "pending");
      assert.equal((await store.readConflict(scope))?.status, "pending");
      const authority: ResolutionAuthority = { accept: async (reference, id, revision, value) => {
        assert.deepEqual(reference, scope); assert.equal(id, "resolve"); assert.equal(revision, 2);
        return { status: "accepted", version: { revision: 3, value } };
      } };
      assert.equal(await service.submit(scope, authority), "resolved");
      assert.equal(await service.submit(scope, authority), "resolved");
      const result = await store.readRecord(scope);
      assert.deepEqual(result?.payload, saved.draft?.value);
      assert.equal(result?.recordId, scope.recordId);
      assert.equal((await store.listRecords(scope)).length, 1);
      assert.equal((await store.listConflicts(scope)).length, 0);
      await store.commit({ ...scope, operationId: "later-edit", kind: "put", payloadJson: JSON.stringify({ ...original, text: "后续进度" }) });
      await service.submit(scope, authority);
      assert.equal((await store.readRecord(scope))?.payload?.text, "后续进度");
    });
  }
});

test("N30 deletion requires a specific choice, can restore the same identity, and never automatically revives", async () => {
  for (const restore of [false, true]) await disk(async (_path, store) => {
    const sequence = await seed(store, null);
    const service = new ConflictService(store, todoConflictPolicy);
    const conflict = await service.retain(comparison(null, { ...original, text: "编辑成果" }), sequence);
    await assert.rejects(service.saveChoice(scope, conflict.generation, "wrong", { kind: "local" }, true));
    assert.equal((await store.readRecord(scope))?.deleted, true);
    const value = { ...original, text: "恢复同一任务" };
    await service.saveChoice(scope, conflict.generation, "delete-choice", restore ? { kind: "restore", value } : { kind: "delete" }, true);
    await service.submit(scope, { accept: async (_scope, _id, _revision, selected) => ({ status: "accepted", version: { revision: 3, value: selected } }) });
    assert.equal((await store.readRecord(scope))?.deleted, !restore);
    assert.equal((await store.listRecords(scope)).length, 1);
    if (restore) assert.deepEqual((await store.readRecord(scope))?.payload, value);
  });
});

test("N30 remote changes and lost authority responses preserve drafts and retry the frozen operation", async () => disk(async (path, store) => {
  const sequence = await seed(store);
  const service = new ConflictService(store, todoConflictPolicy);
  const conflict = await service.retain(differing(), sequence);
  await service.saveChoice(scope, conflict.generation, "old-choice", { kind: "manual", value: { ...original, text: "用户整理" } }, true);
  assert.equal(await service.submit(scope, { accept: async () => ({ status: "changed", version: { revision: 3, value: { ...original, text: "更晚进度" } } }) }), "changed");
  const changed = (await store.readConflict(scope))!;
  assert.equal(changed.draft?.value?.text, "用户整理");
  assert.equal(changed.draft?.submitted, false);
  await service.saveChoice(scope, changed.generation, "new-choice", changed.draft!.choice, true);
  let calls = 0;
  const authority: ResolutionAuthority = { accept: async (_reference, id, revision, value) => {
    assert.equal(id, "new-choice"); assert.equal(revision, 3);
    if (++calls === 1) throw new Error("response lost after authority commit");
    return { status: "accepted", version: { revision: 4, value } };
  } };
  await assert.rejects(service.submit(scope, authority));
  const uncertain = (await store.readConflict(scope))!;
  await assert.rejects(service.saveChoice(scope, uncertain.generation, "overwrite-unknown", { kind: "remote" }, true));
  const reopened = await SqliteLocalStore.open({ databasePath: path });
  try { assert.equal(await new ConflictService(reopened, todoConflictPolicy).submit(scope, authority), "resolved"); }
  finally { await reopened.close(); }
  assert.equal((await store.readRecord(scope))?.payload?.text, "用户整理");
}));

test("N30 failed final transaction preserves pending materials and the same authority receipt is recoverable", async () => disk(async (path, store) => {
  const sequence = await seed(store);
  const service = new ConflictService(store, todoConflictPolicy);
  const conflict = await service.retain(differing(), sequence);
  const invalid = { ...original, text: "" };
  const draft = await service.saveChoice(scope, conflict.generation, "incomplete", { kind: "manual", value: invalid }, false);
  await assert.rejects(service.saveChoice(scope, draft.generation, "invalid-submit", { kind: "manual", value: invalid }, true));
  const saved = await service.saveChoice(scope, draft.generation, "valid", { kind: "local" }, true);
  const authority: ResolutionAuthority = { accept: async (_scope, _id, _revision, value) => ({ status: "accepted", version: { revision: 3, value } }) };
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TRIGGER fail_finish BEFORE UPDATE ON retained_conflicts WHEN NEW.status='resolved' BEGIN SELECT RAISE(ABORT,'failure'); END");
    await assert.rejects(service.submit(scope, authority));
    assert.deepEqual(await store.readConflict(scope), saved);
    assert.equal((await store.readRecord(scope))?.localSequence, sequence);
    assert.equal(await store.readOperation({ ...scope, operationId: "valid" }), null);
    db.exec("DROP TRIGGER fail_finish");
  } finally { db.close(); }
  assert.equal(await service.submit(scope, authority), "resolved");
}));

test("N29 v1 database is upgraded transactionally without losing pending work", async () => disk(async (path, store) => {
  await seed(store);
  const db = new DatabaseSync(path);
  try { db.exec("DROP TABLE retained_conflicts; DROP TABLE authority_receipts; DROP TABLE authority_versions; DROP TABLE replica_progress; DROP TABLE operation_delivery; DROP TABLE replica_cursors; DROP TABLE editor_drafts; DROP TABLE mcp_calls; DROP TABLE mcp_grants; DROP TABLE mcp_requests; DROP TABLE mcp_host_programs; PRAGMA user_version=1"); } finally { db.close(); }
  const reopened = await SqliteLocalStore.open({ databasePath: path });
  try {
    assert.equal((await reopened.readRecord(scope))?.payload?.text, "本机");
    assert.equal((await reopened.listPending(scope)).length, 1);
    assert.equal((await reopened.listConflicts(scope)).length, 0);
  } finally { await reopened.close(); }
}));

test("N30 an old accepted receipt cannot overwrite a newer fetched authority version", async () => disk(async (_path, store) => {
  const sequence = await seed(store);
  const service = new ConflictService(store, todoConflictPolicy);
  const retained = await service.retain(differing(), sequence);
  await service.saveChoice(scope, retained.generation, "late-receipt", { kind: "local" }, true);
  await service.retain({ ...differing(), remote: { revision: 5, value: { ...original, text: "更新的权威进度" } } }, sequence);
  assert.equal(await service.submit(scope, { accept: async (_scope, _id, _revision, value) => ({ status: "accepted", version: { revision: 3, value } }) }), "changed");
  const pending = (await store.readConflict(scope))!;
  assert.equal(pending.status, "pending");
  assert.equal(pending.comparison.remote?.revision, 5);
  assert.equal(pending.draft?.value?.text, "本机");
  assert.equal((await store.readRecord(scope))?.localSequence, sequence);
}));

test("N29 incomplete materials and unavailable domain rules are retained without enabling full replacement", async () => disk(async (_path, store) => {
  const sequence = await seed(store);
  const service = new ConflictService(store);
  const input = { ...differing(), remote: null, base: null };
  const retained = await service.retain(input, sequence);
  assert.equal(retained.comparison.remote, null);
  await assert.rejects(service.saveChoice(scope, retained.generation, "missing", { kind: "remote" }, true));
  assert.equal((await store.readRecord(scope))?.payload?.text, "本机");
  assert.deepEqual(await service.retain(input, sequence), retained);
}));

test("N31 shared lifecycle retains divergence before processing and resolves back to one original record", async () => disk(async (_path, store) => {
  const sequence = await seed(store);
  const decision = await new ConcurrentContent(store, todoConflictPolicy).evaluate(differing(), sequence);
  assert.equal(decision.status, "retained");
  const retained = (await store.readConflict(scope))!;
  const service = new ConflictService(store, todoConflictPolicy);
  await service.saveChoice(scope, retained.generation, "integrated", { kind: "manual", value: { ...original, text: "共同成果" } }, true);
  await service.submit(scope, { accept: async (_scope, _id, _revision, value) => ({ status: "accepted", version: { revision: 3, value } }) });
  assert.equal((await store.readRecord(scope))?.payload?.text, "共同成果");
  assert.equal((await store.listConflicts(scope)).length, 0);
  assert.equal((await store.listRecords(scope)).length, 1);
}));
