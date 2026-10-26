import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DomainRegistry, DOMAIN_REGISTRY } from "@workspace/core";
import { FileExtensionPrograms, SqliteLocalStore } from "@workspace/adapters";
import { parseExtension, validateExtensionRecord } from "@workspace/extension-sdk";

const sample = await readFile("extensions/sample-independent-domain/extension.json", "utf8");
async function fixture(run: (store: SqliteLocalStore, programs: FileExtensionPrograms, path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "workspace-domains-"));
  const path = join(directory, "replica.sqlite");
  const store = await SqliteLocalStore.open({ databasePath: path });
  try { await run(store, new FileExtensionPrograms(join(directory, "programs")), path); }
  finally {
    await store.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.split(/[/\\]/).at(-1)?.startsWith("workspace-domains-"));
    await rm(directory, { recursive: true, force: true });
  }
}

test("N07 registration survives restart, repeats without extra pending work and restores missing local programs", async () => fixture(async (store, programs, path) => {
  const registry = new DomainRegistry("space", store, programs);
  const definition = parseExtension(sample);
  assert.equal(await registry.register(definition, "register-1"), "registered");
  assert.equal(await registry.register(definition, "register-1"), "already-registered");
  assert.equal((await store.listPending({ workspaceId: "space", domainId: DOMAIN_REGISTRY })).length, 1);
  const entry = await registry.get(definition.domainId);
  assert.equal(entry.enabled, false);
  await programs.remove(entry.fingerprint);
  assert.equal((await registry.get(definition.domainId)).programAvailable, false);
  assert.equal(await registry.register(definition, "restore-1"), "program-restored");
  await writeFile(join(dirname(path), "programs", entry.fingerprint + ".json"), "interrupted installation");
  assert.equal((await registry.get(definition.domainId)).programAvailable, false);
  assert.equal(await registry.register(definition, "repair-program"), "program-restored");
  assert.deepEqual(parseExtension(JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(sample)).reverse()))), definition);
  const otherDevice = new DomainRegistry("space", store, new FileExtensionPrograms(join(dirname(path), "other-device")));
  assert.equal((await otherDevice.get(definition.domainId)).programAvailable, false);
  const reopened = await SqliteLocalStore.open({ databasePath: path });
  try { assert.equal((await new DomainRegistry("space", reopened, programs).get(definition.domainId)).programAvailable, true); }
  finally { await reopened.close(); }
}));

test("N07 same name is isolated, changed program is rejected and concurrent registration cannot overwrite", async () => fixture(async (store, programs, path) => {
  const definition = parseExtension(sample);
  const registry = new DomainRegistry("space", store, programs);
  await registry.register(definition, "original");
  await registry.register({ ...definition, domainId: "example.second" }, "second");
  assert.equal((await registry.list()).length, 2);
  await assert.rejects(registry.register({ ...definition, version: "2.0.0" }, "upgrade"), /不同程序或版本/);
  const other = await SqliteLocalStore.open({ databasePath: path });
  try {
    const first = { ...definition, domainId: "example.race" };
    const second = { ...first, name: "另一程序" };
    const results = await Promise.allSettled([registry.register(first, "race-a"), new DomainRegistry("space", other, programs).register(second, "race-b")]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await registry.list()).length, 3);
  } finally { await other.close(); }
}));

test("N07 malformed packages, scripts and cross-domain access are rejected; valid independent data is supported", () => {
  const definition = parseExtension(sample);
  validateExtensionRecord(definition, { quote: "一段摘录", book: "书名" });
  assert.throws(() => validateExtensionRecord(definition, { text: "待办字段不能混入摘录" }));
  for (const source of ["invalid", JSON.stringify({ ...definition, access: "all-domains" }), JSON.stringify({ ...definition, script: "require('fs')" }), JSON.stringify({ ...definition, hostApi: 2 })]) {
    assert.throws(() => parseExtension(source));
  }
});

test("N08 enable and disable persist without removing business data; missing program cannot enable", async () => fixture(async (store, programs) => {
  const definition = parseExtension(sample);
  const registry = new DomainRegistry("space", store, programs);
  await registry.register(definition, "register");
  await store.commit({ workspaceId: "space", domainId: definition.domainId, recordId: "old-content", operationId: "old-content-op", kind: "put", payloadJson: JSON.stringify({ quote: "旧成果", book: "旧书" }) });
  await registry.setEnabled(definition.domainId, true, "enable");
  await registry.setEnabled(definition.domainId, false, "disable");
  assert.equal((await registry.get(definition.domainId)).enabled, false);
  assert.equal((await store.listRecords({ workspaceId: "space", domainId: definition.domainId })).length, 1);
  assert.equal((await store.listPending({ workspaceId: "space", domainId: definition.domainId })).length, 1);
  await programs.remove((await registry.get(definition.domainId)).fingerprint);
  await assert.rejects(registry.setEnabled(definition.domainId, true, "missing-enable"), /缺少兼容程序/);
  assert.equal((await registry.get(definition.domainId)).enabled, false);
}));

test("N09 removing a program preserves registration, enabled state, contents and pending operations", async () => fixture(async (store, programs) => {
  const definition = parseExtension(sample);
  const registry = new DomainRegistry("space", store, programs);
  await registry.register(definition, "register");
  await registry.setEnabled(definition.domainId, true, "enable");
  const before = await store.listPending({ workspaceId: "space", domainId: DOMAIN_REGISTRY });
  await registry.removeProgram(definition.domainId);
  await registry.removeProgram(definition.domainId);
  const missing = await registry.get(definition.domainId);
  assert.equal(missing.programAvailable, false);
  assert.equal(missing.enabled, true);
  assert.deepEqual(await store.listPending({ workspaceId: "space", domainId: DOMAIN_REGISTRY }), before);
  await registry.register(definition, "restore");
  assert.equal((await registry.get(definition.domainId)).enabled, true);
}));

test("N11 todo input permits Chinese and multiline paste, rejects only whitespace and retains original text", async () => {
  const { prepareTodo } = await import("@workspace/todo-list");
  assert.throws(() => prepareTodo(" \n\t ", "2026-10-25T00:00:00.000Z"), /请填写任务内容/);
  const text = "  中文第一行\n明天 [x] 仍是文字  ";
  assert.deepEqual(prepareTodo(text, "2026-10-25T00:00:00.000Z"), { text, createdAt: "2026-10-25T00:00:00.000Z", completed: false });
});

test("N10 domain-scoped persistence rejects cross-domain access and checks disable under the final write lock", async () => fixture(async (store, programs) => {
  const definition = parseExtension(sample);
  const registry = new DomainRegistry("space", store, programs);
  await registry.register(definition, "register");
  await registry.setEnabled(definition.domainId, true, "enable");
  const content = await registry.contentStore(definition.domainId);
  await assert.rejects(content.listRecords({ workspaceId: "space", domainId: "other-domain" }), /无权访问/);
  await registry.setEnabled(definition.domainId, false, "disable");
  await assert.rejects(content.commit({ workspaceId: "space", domainId: definition.domainId, recordId: "late", operationId: "late", kind: "put", payloadJson: JSON.stringify({ quote: "late", book: "late" }) }));
  assert.equal((await store.listRecords({ workspaceId: "space", domainId: definition.domainId })).length, 0);
}));

test("N13–N15 a lost todo receipt recovers the original operation and concurrent copies create only one task", async () => fixture(async (store, programs) => {
  const { todoDefinition, prepareTodo } = await import("@workspace/todo-list");
  const { LocalContentService } = await import("@workspace/core");
  const registry = new DomainRegistry("space", store, programs);
  await registry.register(todoDefinition, "register-todo");
  await registry.setEnabled(todoDefinition.domainId, true, "enable-todo");
  const content = await registry.contentStore(todoDefinition.domainId);
  const change = { workspaceId: "space", domainId: todoDefinition.domainId, recordId: "task", operationId: "capture", kind: "put" as const, payload: prepareTodo("同一条任务", "2026-10-25T00:00:00.000Z") };
  const service = new LocalContentService({ ...content, commit: async (input) => { await content.commit(input, null); throw new Error("lost acknowledgement"); } });
  assert.equal((await service.save(change)).status, "save-unconfirmed");
  assert.equal((await service.recover(change)).status, "saved-local");
  const normal = new LocalContentService({ ...content, commit: (input) => content.commit(input, null) });
  const repeated = await Promise.all(Array.from({ length: 8 }, () => normal.save(change)));
  assert.ok(repeated.every((result) => result.status === "saved-local"));
  assert.equal((await content.listRecords(change)).length, 1);
  assert.equal((await content.listPending(change)).length, 1);
  await registry.setEnabled(todoDefinition.domainId, false, "disable-todo");
  assert.equal((await service.recover(change)).status, "saved-local");
  assert.equal((await normal.save({ ...change, recordId: "new-task", operationId: "after-disable" })).status, "not-saved");
}));
