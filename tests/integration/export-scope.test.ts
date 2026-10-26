import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLocalStore } from "@workspace/adapters";
import { describeExportScope } from "@workspace/core";
import { DatabaseSync } from "node:sqlite";

test("N50 local scope is offline, read-only, includes disabled and unknown domains and distinct pending materials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-export-scope-"));
  const databasePath = join(directory, "replica.sqlite");
  let store = await SqliteLocalStore.open({ databasePath });
  const workspace = { workspaceId: "w", authorityId: "a", creationId: "c", name: "原空间", createdAt: "2026-10-26T00:00:00Z", formatVersion: 1 as const };
  try {
    await store.commit({ workspaceId: "w", domainId: "system.domains", recordId: "notes", operationId: "register", kind: "put", payloadJson: JSON.stringify({ definition: { domainId: "notes", name: "笔记" }, enabled: false, fingerprint: "f".repeat(64) }) });
    await store.commit({ workspaceId: "w", domainId: "notes", recordId: "r", operationId: "create", kind: "put", payloadJson: JSON.stringify({ text: "未同步" }) });
    await store.commit({ workspaceId: "w", domainId: "unknown", recordId: "u", operationId: "unknown", kind: "put", payloadJson: JSON.stringify({ raw: "未知领域原数据" }) });
    await store.commit({ workspaceId: "w", domainId: "notes", recordId: "deleted", operationId: "delete", kind: "delete", payloadJson: null });
    const recordScope = { workspaceId: "w", domainId: "notes", recordId: "r" };
    const local = await store.readRecord(recordScope);
    await store.writeConflict({ ...recordScope, generation: 1, comparison: { ...recordScope, base: null, local: { baseRevision: 0, value: local!.payload, changed: [] }, remote: { revision: 1, value: { text: "另一方" } }, remoteChanged: [] },
      reasons: ["both-changed"], remoteHistory: [], draft: null, status: "pending", editorValue: { text: "已保存的冲突整理" } }, null, local!.localSequence);
    const ordinary = await store.readRecord({ workspaceId: "w", domainId: "unknown", recordId: "u" });
    await store.saveEditor({ workspaceId: "w", domainId: "unknown", recordId: "u", baseSequence: ordinary!.localSequence, operationId: "unsaved", value: { raw: "普通未提交输入" } });
    await store.close(); store = await SqliteLocalStore.open({ databasePath, readOnly: true });
    const inventory = await store.exportInventory("w", "local");
    assert.equal(inventory.domains.length, 2); assert.equal(inventory.pending, 4);
    assert.equal(inventory.conflicts, 1); assert.equal(inventory.savedEditing, 1);
    assert.equal(inventory.domains.find(d => d.domainId === "notes")?.registration?.enabled, false);
    assert.equal(inventory.domains.find(d => d.domainId === "notes")?.deletions, 1);
    const scope = describeExportScope(workspace, "local", databasePath, inventory, workspace.createdAt);
    assert.match(scope.limitations.join(" "), /不代表统一位置最新全量/);
    assert.match(scope.limitations.join(" "), /未提交输入/);
    assert.equal(JSON.stringify(scope).includes("secret_hash"), false);
    const authority = describeExportScope(workspace, "authority", "https://example.test", await store.exportInventory("w", "authority"), workspace.createdAt);
    assert.equal(authority.pending, 0); assert.equal(authority.domains.length, 0);
    await store.close();
    const db = new DatabaseSync(databasePath); db.exec("DROP TABLE local_records"); db.close();
    await assert.rejects(SqliteLocalStore.open({ databasePath, readOnly: true }));
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
