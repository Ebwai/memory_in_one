import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DomainRegistry, ExistingContentService } from "@workspace/core";
import { FileExtensionPrograms, SqliteLocalStore } from "@workspace/adapters";
import { prepareTodoMutation, todoDefinition } from "@workspace/todo-list";
import type { TodoCommand } from "@workspace/todo-list";
import type { JsonObject, LocalPersistence } from "@workspace/contracts";

const at = "2026-10-25T10:00:00.000Z";
const scope = { workspaceId: "space", domainId: "builtin.todo", recordId: "task" };
async function fixture(run: (store: SqliteLocalStore, content: LocalPersistence, path: string, registry: DomainRegistry) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "workspace-progress-"));
  const path = join(directory, "replica.sqlite");
  const store = await SqliteLocalStore.open({ databasePath: path });
  try {
    const registry = new DomainRegistry("space", store, new FileExtensionPrograms(join(directory, "programs")));
    await registry.register(todoDefinition, "register"); await registry.setEnabled("builtin.todo", true, "enable");
    await store.commit({ ...scope, operationId: "create", kind: "put", payloadJson: JSON.stringify({ text: "原文字", completed: false, createdAt: "2026-10-24T01:00:00.000Z", dueDate: "2026-10-24" }) });
    await run(store, await registry.contentStore("builtin.todo"), path, registry);
  } finally {
    await store.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.split(/[/\\]/).at(-1)?.startsWith("workspace-progress-"));
    await rm(directory, { recursive: true, force: true });
  }
}
async function mutate(content: LocalPersistence, operationId: string, baseSequence: number, command: TodoCommand, time = at) {
  return new ExistingContentService(content).mutate({ ...scope, operationId }, baseSequence, (payload) => prepareTodoMutation(payload, command, time));
}

test("N21 changes only text, preserves identity and completed attributes, and rejects whitespace", async () => fixture(async (store, content) => {
  const initial = (await store.readRecord(scope))!;
  assert.equal((await mutate(content, "blank", initial.localSequence, { kind: "text", text: " \n " })).status, "not-saved");
  assert.deepEqual(await store.readRecord(scope), initial);
  const text = "  中文修改\n保留原文  ";
  assert.equal((await mutate(content, "text", initial.localSequence, { kind: "text", text })).status, "saved-local");
  const edited = (await store.readRecord(scope))!;
  assert.deepEqual(edited.payload, { ...initial.payload, text });
  const completed: JsonObject = { ...edited.payload, completed: true, completedAt: at };
  const result = prepareTodoMutation(completed, { kind: "text", text: "相同文字也可以" }, at);
  assert.equal(result.kind, "put");
  if (result.kind === "put") assert.deepEqual(result.payload, { ...completed, text: "相同文字也可以" });
}));

test("N22 accepts valid past, today and future dates, clears only date and refuses invalid values", async () => fixture(async (store, content) => {
  for (const [index, dueDate] of ["2026-01-01", "2026-10-25", "2027-02-28", null].entries()) {
    const before = (await store.readRecord(scope))!;
    assert.equal((await mutate(content, "date-" + index, before.localSequence, { kind: "date", dueDate })).status, "saved-local");
    const after = (await store.readRecord(scope))!;
    const { dueDate: _old, ...retained } = before.payload!;
    assert.deepEqual(after.payload, dueDate === null ? retained : { ...retained, dueDate });
  }
  const before = (await store.readRecord(scope))!;
  assert.equal((await mutate(content, "invalid-date", before.localSequence, { kind: "date", dueDate: "2026-02-30" })).status, "not-saved");
  assert.deepEqual(await store.readRecord(scope), before);
}));

test("N23 complete, restore and complete again retain task fields and use the current completion time", async () => fixture(async (store, content) => {
  const initial = (await store.readRecord(scope))!;
  await mutate(content, "complete", initial.localSequence, { kind: "complete", completed: true });
  const completed = (await store.readRecord(scope))!;
  assert.deepEqual(completed.payload, { ...initial.payload, completed: true, completedAt: at });
  await mutate(content, "restore", completed.localSequence, { kind: "complete", completed: false });
  const restored = (await store.readRecord(scope))!;
  assert.deepEqual(restored.payload, initial.payload);
  const later = "2026-10-25T11:00:00.000Z";
  await mutate(content, "complete-again", restored.localSequence, { kind: "complete", completed: true }, later);
  assert.equal((await store.readRecord(scope))?.payload?.completedAt, later);
  assert.equal((await mutate(content, "complete", initial.localSequence, { kind: "complete", completed: true })).status, "saved-local");
  assert.equal((await store.readRecord(scope))?.payload?.completedAt, later);
}));

test("N24 delete requires confirmation, keeps a tombstone and never resurrects through late editing", async () => fixture(async (store, content) => {
  const initial = (await store.readRecord(scope))!;
  assert.throws(() => prepareTodoMutation(initial.payload!, { kind: "delete", confirmed: false }, at), /明确确认/);
  assert.equal((await mutate(content, "delete", initial.localSequence, { kind: "delete", confirmed: true })).status, "saved-local");
  assert.equal((await store.readRecord(scope))?.deleted, true);
  const count = (await store.listPending(scope)).length;
  assert.equal((await mutate(content, "delete", initial.localSequence, { kind: "delete", confirmed: true })).status, "saved-local");
  assert.equal((await store.listPending(scope)).length, count);
  assert.equal((await mutate(content, "late-edit", initial.localSequence, { kind: "text", text: "不能复活" })).status, "not-saved");
  assert.equal((await store.readRecord(scope))?.deleted, true);
}));

test("N25 concurrent different updates do not overwrite and identical requests share one receipt", async () => fixture(async (store, content, path, registry) => {
  const initial = (await store.readRecord(scope))!;
  const otherStore = await SqliteLocalStore.open({ databasePath: path });
  const otherRegistry = new DomainRegistry("space", otherStore, { stage: async () => "", available: async () => true, remove: async () => undefined });
  try {
    const other = await otherRegistry.contentStore("builtin.todo");
    const results = await Promise.all([mutate(content, "left", initial.localSequence, { kind: "text", text: "左" }), mutate(other, "right", initial.localSequence, { kind: "text", text: "右" })]);
    assert.equal(results.filter((result) => result.status === "saved-local").length, 1);
    const current = (await store.readRecord(scope))!;
    const repeats = await Promise.all([mutate(content, "same", current.localSequence, { kind: "date", dueDate: null }), mutate(other, "same", current.localSequence, { kind: "date", dueDate: null })]);
    assert.ok(repeats.every((result) => result.status === "saved-local"));
    await registry.setEnabled("builtin.todo", false, "disable");
    const next = (await store.readRecord(scope))!;
    assert.equal((await mutate(content, "disabled-write", next.localSequence, { kind: "text", text: "拒绝停用后写入" })).status, "not-saved");
  } finally { await otherStore.close(); }
}));

test("N25 storage rollback and lost acknowledgements preserve input semantics and retry the original operation", async () => fixture(async (store, content, path) => {
  const initial = (await store.readRecord(scope))!;
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TRIGGER fail_progress BEFORE INSERT ON pending_operations WHEN NEW.domain_id = 'builtin.todo' BEGIN SELECT RAISE(ABORT, 'failure'); END");
    assert.equal((await mutate(content, "failed", initial.localSequence, { kind: "text", text: "失败" })).status, "not-saved");
    assert.deepEqual(await store.readRecord(scope), initial);
    db.exec("DROP TRIGGER fail_progress");
  } finally { db.close(); }
  const lost: LocalPersistence = { ...content, commit: async (change, expected) => { await content.commit(change, expected); throw new Error("lost acknowledgement"); } };
  assert.equal((await mutate(lost, "lost", initial.localSequence, { kind: "text", text: "保存但未收到" })).status, "save-unconfirmed");
  const count = (await store.listPending(scope)).length;
  assert.equal((await mutate(content, "lost", initial.localSequence, { kind: "text", text: "保存但未收到" })).status, "saved-local");
  assert.equal((await store.listPending(scope)).length, count);
  assert.equal((await mutate(content, "lost", initial.localSequence, { kind: "text", text: "不能改原请求" })).status, "not-saved");
}));
