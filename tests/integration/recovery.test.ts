import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLocalStore, FileExtensionPrograms, recoverArchive } from "@workspace/adapters";

import { DomainRegistry } from "@workspace/core";
import { parseExtension } from "@workspace/extension-sdk";

test("N61 independent extension survives disabled missing-program recovery, re-export and compatible reinstall", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-extension-recovery-"));
  const store = await SqliteLocalStore.open({ databasePath: join(directory, "source.sqlite") });
  const workspace = { workspaceId: "w", authorityId: "a", name: "扩展空间", creationId: "c", createdAt: new Date().toISOString() };
  try {
    const definition = parseExtension(await readFile("extensions/sample-independent-domain/extension.json", "utf8"));
    const registry = new DomainRegistry("w", store, new FileExtensionPrograms(join(directory, "source-programs")));
    await registry.register(definition, "register"); await registry.setEnabled(definition.domainId, true, "enable");
    const scoped = await registry.contentStore(definition.domainId);
    await scoped.commit({ workspaceId: "w", domainId: definition.domainId, recordId: "quote", operationId: "save", kind: "put", payloadJson: JSON.stringify({ quote: "独立摘录", book: "书名" }) });
    await registry.setEnabled(definition.domainId, false, "disable"); await registry.removeProgram(definition.domainId);
    const archive = { workspace, location: "source", snapshot: await store.snapshot("w", "local") };
    const restored = await recoverArchive(archive, join(directory, "target"), true);
    assert.equal(restored.domains[0]?.available, false);
    const result = await SqliteLocalStore.open({ databasePath: restored.databasePath });
    try {
      const recoveredRegistry = new DomainRegistry("w", result, new FileExtensionPrograms(join(directory, "target-programs")));
      assert.equal((await recoveredRegistry.get(definition.domainId)).enabled, false);
      assert.equal((await recoveredRegistry.get(definition.domainId)).programAvailable, false);
      assert.deepEqual((await result.snapshot("w", "local")).tables, archive.snapshot.tables);
      assert.equal(await recoveredRegistry.register(definition, "reinstall"), "program-restored");
      await recoveredRegistry.setEnabled(definition.domainId, true, "reenable");
      const content = await recoveredRegistry.contentStore(definition.domainId);
      const record = await content.readRecord({ workspaceId: "w", domainId: definition.domainId, recordId: "quote" });
      assert.equal(record?.payload?.quote, "独立摘录"); assert.equal(record?.payload?.completed, undefined);
    } finally { await result.close(); }
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("N54–N57 recovery is isolated, preserves original operations, checks occupancy again and resumes same result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-recovery-"));
  const store = await SqliteLocalStore.open({ databasePath: join(directory, "source.sqlite") });
  const workspace = { workspaceId: "w", authorityId: "a", name: "原空间", creationId: "c", createdAt: new Date().toISOString() };
  try {
    const scope = { workspaceId: "w", domainId: "unknown", recordId: "r" };
    await store.commit({ ...scope, operationId: "op", kind: "put", payloadJson: '{"text":"原内容"}' });
    await store.commit({ ...scope, recordId: "gone", operationId: "del", kind: "delete", payloadJson: null });
    const archive = { workspace, location: "https://old.invalid", snapshot: await store.snapshot("w", "local") };
    const target = join(directory, "recovered");
    const preview = await recoverArchive(archive, target);
    assert.equal(preview.pending, 2); assert.equal(preview.state, "local");
    assert.equal(preview.domains[0]?.available, false);
    assert.equal((await readdir(directory)).includes("recovered"), false);
    const result = await recoverArchive(archive, target, true);
    assert.equal(result.workspace.workspaceId, "w");
    const restored = await SqliteLocalStore.open({ databasePath: result.databasePath });
    try {
      assert.equal((await restored.readRecord(scope))?.payload?.text, "原内容");
      assert.equal((await restored.readOperation({ ...scope, operationId: "op" }))?.recordId, "r");
      assert.deepEqual((await restored.snapshot("w", "local")).tables, archive.snapshot.tables);
    } finally { await restored.close(); }
    assert.equal((await recoverArchive(archive, target, true)).alreadyRestored, true);
    await assert.rejects(recoverArchive({ ...archive, snapshot: { ...archive.snapshot, schemaVersion: 999 } }, join(directory, "bad")));
    const broken = structuredClone(archive); (broken.snapshot.tables.local_records![0] as Record<string, unknown>).last_sequence = 999;
    await assert.rejects(recoverArchive(broken, join(directory, "broken")));
    const interrupted = join(directory, "interrupted");
    const interruptedPreview = await recoverArchive(archive, interrupted);
    await mkdir(interrupted);
    await writeFile(join(interrupted, ".restore-" + interruptedPreview.fingerprint + ".sqlite"), "");
    assert.equal((await recoverArchive(archive, interrupted, true)).alreadyRestored, false);
    const occupied = join(directory, "occupied");
    await recoverArchive(archive, occupied);
    await writeFile(occupied, "unrelated");
    await assert.rejects(recoverArchive(archive, occupied, true));
    const authority = { workspace, location: "old", snapshot: await store.snapshot("w", "authority") };
    const prepared = await recoverArchive(authority, join(directory, "prepared"), true);
    assert.equal(prepared.state, "prepared");
    const authorityStore = await SqliteLocalStore.open({ databasePath: prepared.databasePath });
    try {
      await assert.rejects(authorityStore.authorityCommit({ ...scope, authorityId: "a", operationId: "new", baseRevision: 0, value: { text: "forbidden" }, changed: [], resolution: false }, { text: "forbidden" }, 0, [], []));
    } finally { await authorityStore.close(); }
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
