import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteLocalStore } from "@workspace/adapters";

test("N51 snapshot freezes complete local continuation, excludes other spaces and secrets, survives later writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-snapshot-"));
  const databasePath = join(directory, "replica.sqlite");
  const store = await SqliteLocalStore.open({ databasePath });
  try {
    const scope = { workspaceId: "w", domainId: "unknown", recordId: "r" };
    await store.commit({ ...scope, operationId: "first", kind: "put", payloadJson: '{"text":"before"}' });
    await store.commit({ ...scope, recordId: "gone", operationId: "delete", kind: "delete", payloadJson: null });
    await store.commit({ ...scope, workspaceId: "other", operationId: "foreign", kind: "put", payloadJson: '{"private":true}' });
    const record = await store.readRecord(scope);
    await store.saveEditor({ ...scope, baseSequence: record!.localSequence, operationId: "input", value: { text: "ordinary unsaved input" } });
    await store.writeConflict({ ...scope, generation: 1, comparison: { ...scope, base: null, local: { baseRevision: 0, value: record!.payload, changed: [] }, remote: { revision: 1, value: { text: "remote" } }, remoteChanged: [] }, reasons: ["both-changed"], remoteHistory: [], draft: null, status: "pending", editorValue: { text: "saved conflict" } }, null, record!.localSequence);
    const snapshot = await store.snapshot("w", "local");
    await store.commit({ ...scope, recordId: "later", operationId: "later", kind: "put", payloadJson: '{"text":"after"}' });
    assert.equal(snapshot.tables.pending_operations!.length, 2);
    assert.equal(snapshot.tables.operation_delivery!.length, 2);
    assert.equal(snapshot.tables.local_records!.find(row => row.record_id === "r")?.payload_json, '{"text":"before"}');
    assert.equal(snapshot.tables.local_records!.find(row => row.record_id === "gone")?.deleted, 1);
    const text = JSON.stringify(snapshot);
    assert.ok(text.includes("saved conflict"));
    assert.ok(!text.includes("ordinary unsaved input"));
    assert.ok(!text.includes("foreign"));
    assert.equal(snapshot.tables.mcp_grants, undefined);
    assert.equal((await store.readRecord({ ...scope, recordId: "later" }))?.payload?.text, "after");
    const readOnly = await SqliteLocalStore.open({ databasePath, readOnly: true });
    try { assert.equal((await readOnly.snapshot("w", "local")).tables.pending_operations!.length, 3); }
    finally { await readOnly.close(); }
    const db = new DatabaseSync(databasePath);
    db.prepare("DELETE FROM operation_delivery WHERE sequence=?").run(record!.localSequence); db.close();
    await assert.rejects(store.snapshot("w", "local"));
    assert.equal((await store.readRecord({ ...scope, recordId: "later" }))?.payload?.text, "after");
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
