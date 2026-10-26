import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLocalStore, deliverArchive, readArchive, decodeArchive, encodeArchive } from "@workspace/adapters";

test("N52–N53 complete files verify, reject corruption and preserve previous file on failed replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-archive-"));
  const store = await SqliteLocalStore.open({ databasePath: join(directory, "source.sqlite") });
  try {
    await store.commit({ workspaceId: "w", domainId: "notes", recordId: "r", operationId: "op", kind: "put", payloadJson: '{"text":"original"}' });
    const archive = { workspace: { workspaceId: "w", authorityId: "a", name: "原空间", creationId: "c", createdAt: new Date().toISOString() }, location: "原位置", snapshot: await store.snapshot("w", "local") };
    const path = join(directory, "data.workspace.json");
    await deliverArchive(path, archive);
    assert.deepEqual(await readArchive(path), archive);
    const original = await readFile(path, "utf8");
    assert.throws(() => decodeArchive(original.replace("original", "changed")));
    await assert.rejects(deliverArchive(path, { ...archive, location: "later" }));
    assert.equal(await readFile(path, "utf8"), original);
    await assert.rejects(deliverArchive(path, { ...archive, workspace: { ...archive.workspace, workspaceId: "wrong" } }, true));
    assert.equal(await readFile(path, "utf8"), original);
    await deliverArchive(path, { ...archive, location: "later" }, true);
    assert.equal((await readArchive(path)).location, "later");
    assert.equal((await readdir(directory)).some(name => name.endsWith(".partial")), false);
    assert.throws(() => decodeArchive(encodeArchive(archive).slice(0, -10)));
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
