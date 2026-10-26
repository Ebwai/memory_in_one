import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { startWorkspaceServer } from "@workspace/server/initialization";
import { DomainRegistry, ExistingContentService, SyncEngine, WorkspaceInitialization, ConflictService } from "@workspace/core";
import { FileExtensionPrograms, HttpSyncRemote, HttpWorkspaceLocation, SqliteLocalStore } from "@workspace/adapters";
import { prepareTodoMutation, todoConflictPolicy, todoDefinition } from "@workspace/todo-list";
import type { JsonObject, SyncRemote, WorkspaceIdentity } from "@workspace/contracts";

const token = "sync-owner-secret-012345678901234567890123";
const payload: JsonObject = { text: "原任务", completed: false, createdAt: "2026-10-26T00:00:00Z" };
const policy = (domain: string) => domain === "builtin.todo" ? todoConflictPolicy : domain === "system.domains" ? {
  attributes: { enabled: ["enabled"] }, validate: () => undefined,
} : undefined;
async function fixture(run: (a: SqliteLocalStore, b: SqliteLocalStore, remote: HttpSyncRemote, identity: WorkspaceIdentity, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "workspace-sync-"));
  const server = await startWorkspaceServer({ directory: join(directory, "authority"), token });
  const location = new HttpWorkspaceLocation(server.url, token);
  const initialized = await new WorkspaceInitialization(location, randomUUID, () => "2026-10-26T00:00:00Z").create({ creationId: "create-sync", name: "同步空间" });
  assert.equal(initialized.status, "created");
  if (initialized.status !== "created") throw new Error("Initialization failed");
  const a = await SqliteLocalStore.open({ databasePath: join(directory, "a.sqlite") });
  const b = await SqliteLocalStore.open({ databasePath: join(directory, "b.sqlite") });
  const remote = new HttpSyncRemote(server.url, token);
  try {
    const registry = new DomainRegistry(initialized.workspace.workspaceId, a, new FileExtensionPrograms(join(directory, "a-programs")));
    await registry.register(todoDefinition, "register"); await registry.setEnabled("builtin.todo", true, "enable");
    await run(a, b, remote, initialized.workspace, directory);
  } finally {
    await a.close(); await b.close(); await server.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.split(/[/\\]/).at(-1)?.startsWith("workspace-sync-"));
    await rm(directory, { recursive: true, force: true });
  }
}
function scope(identity: WorkspaceIdentity, recordId = "task") { return { workspaceId: identity.workspaceId, domainId: "builtin.todo", recordId }; }
async function create(store: SqliteLocalStore, identity: WorkspaceIdentity, recordId = "task") {
  await store.commit({ ...scope(identity, recordId), operationId: "create-" + recordId, kind: "put", payloadJson: JSON.stringify(payload) }, null);
}
async function text(store: SqliteLocalStore, identity: WorkspaceIdentity, content: string, operationId: string, recordId = "task") {
  const reference = { ...scope(identity, recordId), operationId };
  const record = (await store.readRecord(reference))!;
  return new ExistingContentService(store).mutate(reference, record.localSequence, (value) => prepareTodoMutation(value, { kind: "text", text: content }, "2026-10-26T01:00:00Z"));
}

test("N41–N43 integrated capture, review, progression, offline recovery and shared todo identity", async () => fixture(async (a, b, remote, identity) => {
  await create(a, identity);
  const ea = new SyncEngine(identity, a, remote, policy);
  const eb = new SyncEngine(identity, b, remote, policy);
  await ea.run(); await eb.run();
  assert.equal((await b.readRecord(scope(identity)))?.payload?.text, (await a.readRecord(scope(identity)))?.payload?.text);
  const record = (await b.readRecord(scope(identity)))!;
  const service = new ExistingContentService(b);
  const op = { ...scope(identity), operationId: "package-complete" };
  const complete = (value: Parameters<typeof prepareTodoMutation>[0]) => prepareTodoMutation(value, { kind: "complete", completed: true }, "2026-10-26T03:00:00Z");
  assert.equal((await service.mutate(op, record.localSequence, complete)).status, "saved-local");
  await eb.run(); await ea.pull();
  assert.equal((await a.readRecord(scope(identity)))?.payload?.completed, true);
  const done = (await a.readRecord(scope(identity)))!;
  await new ExistingContentService(a).mutate({ ...scope(identity), operationId: "package-restore" }, done.localSequence,
    value => prepareTodoMutation(value, { kind: "complete", completed: false }, "2026-10-26T04:00:00Z"));
  await ea.run(); await eb.pull();
  assert.equal((await b.readRecord(scope(identity)))?.payload?.completed, false);
  assert.equal((await a.syncSummary(identity.workspaceId)).pending, 0);
  assert.equal((await b.syncSummary(identity.workspaceId)).pending, 0);
  assert.equal((await a.readRecord(scope(identity)))?.recordId, (await b.readRecord(scope(identity)))?.recordId);
}));

test("N32 real HTTP upload is idempotent, ordered and preserves edits made after its earlier acknowledgement", async () => fixture(async (a, _b, remote, identity) => {
  await create(a, identity);
  await text(a, identity, "下一版", "edit");
  const engine = new SyncEngine(identity, a, remote, policy);
  assert.deepEqual(await engine.upload(), []);
  assert.equal((await a.syncSummary(identity.workspaceId)).pending, 0);
  assert.equal((await a.readRecord(scope(identity)))?.payload?.text, "下一版");
  const first = await remote.pull(identity.workspaceId, identity.authorityId, 0);
  assert.equal(first.versions.filter((version) => version.domainId === "builtin.todo").length, 2);
  await engine.upload();
  assert.equal((await remote.pull(identity.workspaceId, identity.authorityId, 0)).versions.length, first.versions.length);
}));

test("N32 lost HTTP acknowledgement freezes the original request across restart and does not duplicate authority results", async () => fixture(async (a, _b, remote, identity, directory) => {
  await new SyncEngine(identity, a, remote, policy).upload();
  await create(a, identity);
  let lost = true;
  const unreliable: SyncRemote = { inspect: () => remote.inspect(), pull: (...args) => remote.pull(...args), upload: async (request) => {
    const result = await remote.upload(request);
    if (request.recordId === "task" && lost) { lost = false; throw new Error("lost response"); }
    return result;
  } };
  assert.equal((await new SyncEngine(identity, a, unreliable, policy).upload()).length, 1);
  assert.equal((await a.syncSummary(identity.workspaceId)).pending, 1);
  assert.equal((await text(a, identity, "之后的新修改", "later")).status, "not-saved");
  const reopened = await SqliteLocalStore.open({ databasePath: join(directory, "a.sqlite") });
  try { assert.deepEqual(await new SyncEngine(identity, reopened, remote, policy).upload(), []); } finally { await reopened.close(); }
  assert.equal((await text(a, identity, "之后的新修改", "later")).status, "saved-local");
  await new SyncEngine(identity, a, remote, policy).upload();
  assert.equal((await a.readRecord(scope(identity)))?.payload?.text, "之后的新修改");
  const page = await remote.pull(identity.workspaceId, identity.authorityId, 0);
  assert.equal(page.versions.filter((version) => version.recordId === "task").length, 2);
}));

test("N33 two disk replicas receive the same content identity and persist a restartable cursor", async () => fixture(async (a, b, remote, identity, directory) => {
  await create(a, identity);
  await new SyncEngine(identity, a, remote, policy).run();
  await new SyncEngine(identity, b, remote, policy).pull();
  assert.deepEqual((await b.readRecord(scope(identity)))?.payload, payload);
  const cursor = await b.cursor(identity.workspaceId);
  assert.ok(cursor > 0);
  const reopened = await SqliteLocalStore.open({ databasePath: join(directory, "b.sqlite") });
  try {
    assert.equal(await reopened.cursor(identity.workspaceId), cursor);
    await new SyncEngine(identity, reopened, remote, policy).pull();
    assert.equal((await reopened.listRecords(scope(identity))).length, 1);
  } finally { await reopened.close(); }
}));

test("N32 concurrent independent fields merge, same fields retain conflict and another record still uploads", async () => fixture(async (a, b, remote, identity) => {
  await create(a, identity);
  const ea = new SyncEngine(identity, a, remote, policy); const eb = new SyncEngine(identity, b, remote, policy);
  await ea.run(); await eb.pull();
  await text(a, identity, "来自A", "edit-a");
  const before = (await b.readRecord(scope(identity)))!;
  await new ExistingContentService(b).mutate({ ...scope(identity), operationId: "date-b" }, before.localSequence,
    (value) => prepareTodoMutation(value, { kind: "date", dueDate: "2026-10-30" }, "2026-10-26T01:00:00Z"));
  await ea.run(); await eb.run(); await ea.pull();
  assert.deepEqual((await a.readRecord(scope(identity)))?.payload, { ...payload, text: "来自A", dueDate: "2026-10-30" });
  assert.deepEqual((await b.readRecord(scope(identity)))?.payload, (await a.readRecord(scope(identity)))?.payload);
  await text(a, identity, "A冲突", "conflict-a"); await text(b, identity, "B冲突", "conflict-b");
  await ea.run(); await create(b, identity, "independent"); await eb.run();
  assert.equal((await b.readConflict(scope(identity)))?.status, "pending");
  assert.ok((await b.confirmed(scope(identity, "independent")))?.revision);
}));

test("N34 deletion propagates and stale editing requires explicit same-identity restoration", async () => fixture(async (a, b, remote, identity) => {
  await create(a, identity);
  const ea = new SyncEngine(identity, a, remote, policy); const eb = new SyncEngine(identity, b, remote, policy);
  await ea.run(); await eb.pull();
  await text(b, identity, "离线编辑", "offline-edit");
  const original = (await a.readRecord(scope(identity)))!;
  await new ExistingContentService(a).mutate({ ...scope(identity), operationId: "delete" }, original.localSequence,
    (value) => prepareTodoMutation(value, { kind: "delete", confirmed: true }, "2026-10-26T01:00:00Z"));
  await ea.run(); await eb.run();
  const conflict = (await b.readConflict(scope(identity)))!;
  assert.equal(conflict.status, "pending");
  assert.equal((await a.readRecord(scope(identity)))?.deleted, true);
  await new ConflictService(b, todoConflictPolicy).saveChoice(scope(identity), conflict.generation, "restore-explicit", { kind: "restore", value: { ...payload, text: "明确恢复" } }, true);
  await eb.run(); await ea.pull();
  assert.equal((await a.readRecord(scope(identity)))?.payload?.text, "明确恢复");
  assert.equal((await a.listRecords(scope(identity))).length, 1);
}));

test("N33 a failed receive transaction does not advance the cursor or clear local data", async () => fixture(async (a, b, remote, identity, directory) => {
  await create(a, identity); await new SyncEngine(identity, a, remote, policy).run();
  const db = new DatabaseSync(join(directory, "b.sqlite"));
  try {
    db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON replica_progress BEGIN SELECT RAISE(ABORT,'failure'); END");
    await assert.rejects(new SyncEngine(identity, b, remote, policy).pull());
    assert.equal(await b.cursor(identity.workspaceId), 0);
    assert.equal((await b.listRecords(scope(identity))).length, 0);
    db.exec("DROP TRIGGER fail_import");
  } finally { db.close(); }
  await new SyncEngine(identity, b, remote, policy).pull();
  assert.deepEqual((await b.readRecord(scope(identity)))?.payload, payload);
}));

test("N37–N40 offline edits, states and deletion survive reopening and resume only into the original authority", async () => fixture(async (a, b, remote, identity, directory) => {
  await create(a, identity);
  const ea = new SyncEngine(identity, a, remote, policy);
  await ea.run();
  await new SyncEngine(identity, b, remote, policy).pull();
  const offline: SyncRemote = { inspect: async () => { throw new Error("offline"); }, upload: (input) => remote.upload(input), pull: (...args) => remote.pull(...args) };
  assert.equal((await text(b, identity, "离线文字", "offline-text")).status, "saved-local");
  let record = (await b.readRecord(scope(identity)))!;
  await new ExistingContentService(b).mutate({ ...scope(identity), operationId: "offline-done" }, record.localSequence, (value) => prepareTodoMutation(value, { kind: "complete", completed: true }, "2026-10-26T02:00:00Z"));
  await create(b, identity, "new-offline");
  record = (await b.readRecord(scope(identity, "new-offline")))!;
  await new ExistingContentService(b).mutate({ ...scope(identity, "new-offline"), operationId: "offline-delete" }, record.localSequence, (value) => prepareTodoMutation(value, { kind: "delete", confirmed: true }, "2026-10-26T02:00:00Z"));
  await assert.rejects(new SyncEngine(identity, b, offline, policy).run());
  const reopened = await SqliteLocalStore.open({ databasePath: join(directory, "b.sqlite") });
  try {
    assert.equal((await reopened.readRecord(scope(identity)))?.payload?.completed, true);
    assert.equal((await reopened.readRecord(scope(identity, "new-offline")))?.deleted, true);
    const wrong: SyncRemote = { ...offline, inspect: async () => ({ ...identity, workspaceId: "wrong-space" }) };
    await assert.rejects(new SyncEngine(identity, reopened, wrong, policy).run());
    assert.ok((await reopened.syncSummary(identity.workspaceId)).pending >= 4);
    await new SyncEngine(identity, reopened, remote, policy).run();
  } finally { await reopened.close(); }
  await ea.pull();
  assert.equal((await a.readRecord(scope(identity)))?.payload?.text, "离线文字");
  assert.equal((await a.readRecord(scope(identity)))?.payload?.completed, true);
  assert.equal((await a.readRecord(scope(identity, "new-offline")))?.deleted, true);
  assert.equal((await b.syncSummary(identity.workspaceId)).pending, 0);
}));

test("N33–N39 a remote deletion retains unfinished editing separately from saved facts", async () => fixture(async (a, b, remote, identity) => {
  await create(a, identity);
  const ea = new SyncEngine(identity, a, remote, policy); const eb = new SyncEngine(identity, b, remote, policy);
  await ea.run(); await eb.pull();
  const record = (await b.readRecord(scope(identity)))!;
  await b.saveEditor({ ...scope(identity), baseSequence: record.localSequence, operationId: "editor", value: { ...payload, text: "未点击保存的整理" } });
  const original = (await a.readRecord(scope(identity)))!;
  await new ExistingContentService(a).mutate({ ...scope(identity), operationId: "delete-editing" }, original.localSequence,
    (value) => prepareTodoMutation(value, { kind: "delete", confirmed: true }, "2026-10-26T01:00:00Z"));
  await ea.run(); await eb.pull();
  const retained = (await b.readConflict(scope(identity)))!;
  assert.equal(retained.status, "pending");
  assert.equal(retained.editorValue?.text, "未点击保存的整理");
  assert.equal((await b.readRecord(scope(identity)))?.payload?.text, "原任务");
  assert.equal((await b.listRecords(scope(identity))).length, 1);
}));

test("N39 lost acknowledgements followed by pull remain uncertain rather than manufacturing a conflict", async () => fixture(async (a, b, remote, identity) => {
  await new SyncEngine(identity, a, remote, policy).upload();
  await create(a, identity);
  const unreliable: SyncRemote = { inspect: () => remote.inspect(), pull: (...args) => remote.pull(...args), upload: async (request) => {
    await remote.upload(request); throw new Error("response lost");
  } };
  await new SyncEngine(identity, a, unreliable, policy).run();
  assert.equal(await a.readConflict(scope(identity)), null);
  assert.equal((await a.syncSummary(identity.workspaceId)).uncertain, 1);
  assert.equal((await text(a, identity, "blocked", "blocked")).status, "not-saved");
  await create(a, identity, "other-after-unknown");
  await new SyncEngine(identity, a, remote, policy).run();
  assert.equal((await a.syncSummary(identity.workspaceId)).uncertain, 0);
  await new SyncEngine(identity, b, remote, policy).pull();
  assert.ok(await b.readRecord(scope(identity, "other-after-unknown")));
}));

test("N32 authority rejects reused operation identities and malformed scope without altering accepted facts", async () => fixture(async (a, _b, remote, identity) => {
  await create(a, identity);
  await new SyncEngine(identity, a, remote, policy).run();
  const wrong = await remote.upload({ ...scope(identity), authorityId: identity.authorityId, operationId: "create-task", baseRevision: 0,
    value: { ...payload, text: "不能冒充原操作" }, changed: [], resolution: false });
  assert.equal(wrong.status, "rejected");
  await assert.rejects(remote.pull("different-space", identity.authorityId, 0));
  await assert.rejects(remote.pull(identity.workspaceId, identity.authorityId, 99999));
  const page = await remote.pull(identity.workspaceId, identity.authorityId, 0);
  assert.equal(page.versions.filter((version) => version.recordId === "task").length, 1);
}));

test("N32 declared custom domains upload sequential updates without inheriting todo semantics or installing on other hosts", async () => fixture(async (a, b, remote, identity, directory) => {
  const definition = { format: 1 as const, domainId: "notes.demo", name: "想法", version: "1.0.0", hostApi: 1 as const, dataVersion: 1 as const, access: "own-domain" as const,
    schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, properties: { title: { type: "string" } }, required: ["title"] },
    view: { titleField: "title", fields: ["title"] }, actions: ["create" as const, "update" as const, "delete" as const] };
  const registry = new DomainRegistry(identity.workspaceId, a, new FileExtensionPrograms(join(directory, "a-programs")));
  await registry.register(definition, "notes-register"); await registry.setEnabled(definition.domainId, true, "notes-enable");
  const record = { workspaceId: identity.workspaceId, domainId: definition.domainId, recordId: "idea" };
  await a.commit({ ...record, operationId: "idea-create", kind: "put", payloadJson: JSON.stringify({ title: "想法一" }) });
  const ea = new SyncEngine(identity, a, remote, policy);
  assert.deepEqual(await ea.run(), []);
  await a.commit({ ...record, operationId: "idea-update", kind: "put", payloadJson: JSON.stringify({ title: "想法二" }) });
  assert.deepEqual(await ea.run(), []);
  await new SyncEngine(identity, b, remote, policy).pull();
  assert.deepEqual((await b.readRecord(record))?.payload, { title: "想法二" });
  const remoteRegistry = new DomainRegistry(identity.workspaceId, b, new FileExtensionPrograms(join(directory, "b-programs")));
  assert.equal((await remoteRegistry.get(definition.domainId)).programAvailable, false);
}));

test("N33 paginated receive advances a durable cursor only through applied pages", async () => fixture(async (a, b, remote, identity, directory) => {
  await create(a, identity);
  await new SyncEngine(identity, a, remote, policy).run();
  const authority = await SqliteLocalStore.open({ databasePath: join(directory, "authority", "workspace.sqlite") });
  try {
    for (let index = 0; index < 104; ++index) {
      const request = { ...scope(identity, "bulk-" + index), authorityId: identity.authorityId, operationId: "bulk-" + index, baseRevision: 0,
        value: payload, changed: ["text"], resolution: false };
      await authority.authorityCommit(request, payload, 0, ["text"], []);
    }
  } finally { await authority.close(); }
  const page = await remote.pull(identity.workspaceId, identity.authorityId, 0);
  assert.equal(page.versions.length, 100); assert.equal(page.more, true);
  await new SyncEngine(identity, b, remote, policy).pull();
  assert.equal((await b.listRecords(scope(identity))).length, 105);
  assert.equal((await remote.pull(identity.workspaceId, identity.authorityId, await b.cursor(identity.workspaceId))).more, false);
}));
