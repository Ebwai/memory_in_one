import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startWorkspaceServer } from "@workspace/server/initialization";
import { SqliteLocalStore, HttpWorkspaceLocation, HttpSyncRemote, FileExtensionPrograms, recoverArchive, authorityFromLocal } from "@workspace/adapters";
import { WorkspaceInitialization, DomainRegistry, SyncEngine, ExistingContentService } from "@workspace/core";
import { todoDefinition, todoConflictPolicy, prepareTodo, prepareTodoMutation } from "@workspace/todo-list";

test("N58–N60 stopped authority migrates once; original offline operations resume without duplicate or resurrection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-migration-"));
  const token = "migration-owner-".repeat(4);
  const oldDirectory = join(directory, "old");
  const old = await startWorkspaceServer({ directory: oldDirectory, token });
  let next: Awaited<ReturnType<typeof startWorkspaceServer>> | undefined;
  const a = await SqliteLocalStore.open({ databasePath: join(directory, "client.sqlite") });
  let authority: SqliteLocalStore | undefined;
  try {
    const created = await new WorkspaceInitialization(new HttpWorkspaceLocation(old.url, token), randomUUID, () => new Date().toISOString()).create({ creationId: "migration", name: "迁移空间" });
    assert.equal(created.status, "created"); if (created.status !== "created") throw new Error("create failed");
    const w = created.workspace;
    authority = await SqliteLocalStore.open({ databasePath: join(oldDirectory, "workspace.sqlite") });
    const registry = new DomainRegistry(w.workspaceId, a, new FileExtensionPrograms(join(directory, "programs")));
    await registry.register(todoDefinition, "register"); await registry.setEnabled("builtin.todo", true, "enable");
    const scope = { workspaceId: w.workspaceId, domainId: "builtin.todo", recordId: "task" };
    await a.commit({ ...scope, operationId: "create-task", kind: "put", payloadJson: JSON.stringify(prepareTodo("迁移前", new Date().toISOString())) });
    const policies = (id: string) => id === "builtin.todo" ? todoConflictPolicy : { attributes: { enabled: ["enabled"] }, validate: () => undefined };
    await new SyncEngine(w, a, new HttpSyncRemote(old.url, token), policies).run();
    const grantResponse = await fetch(old.url + "/v1/mcp/grant-create", { method: "POST", headers: { authorization: "Bearer " + token }, body: JSON.stringify({ name: "恢复前授权", domains: ["builtin.todo"], actions: ["read"] }) });
    assert.equal(grantResponse.ok, true);
    const oldGrant = await grantResponse.json() as { credential: string };
    const earlyLocal = { workspace: w, location: old.url, snapshot: await a.snapshot(w.workspaceId, "local") };
    const early = { workspace: w, location: old.url, snapshot: await authority.snapshot(w.workspaceId, "authority") };
    const earlyTarget = await recoverArchive(early, join(directory, "early"), true);
    const earlyStore = await SqliteLocalStore.open({ databasePath: earlyTarget.databasePath });
    try { await assert.rejects(earlyStore.authorityControl(w.workspaceId, w.authorityId, "activate")); }
    finally { await earlyStore.close(); }
    const call = async (url: string, method: string, input = {}) => {
      const r = await fetch(url + "/v1/mcp/" + method, { method: "POST", headers: { authorization: "Bearer " + token }, body: JSON.stringify(input) });
      if (!r.ok) throw new Error("control failed " + await r.text()); return await r.json() as { state: string };
    };
    assert.equal((await call(old.url, "migration-stop")).state, "stopped");
    const archive = { workspace: w, location: old.url, snapshot: await authority.snapshot(w.workspaceId, "authority") };
    assert.equal(archive.snapshot.authorityState, "stopped");
    assert.ok(JSON.stringify(archive).includes("恢复前授权"));
    assert.ok(!JSON.stringify(archive).includes(oldGrant.credential));
    assert.equal(archive.snapshot.tables.mcp_grants, undefined);
    const record = (await a.readRecord(scope))!;
    await new ExistingContentService(a).mutate({ ...scope, operationId: "offline-update" }, record.localSequence, value => prepareTodoMutation(value, { kind: "text", text: "迁移后接续" }, new Date().toISOString()));
    const errors = await new SyncEngine(w, a, new HttpSyncRemote(old.url, token), policies).run();
    assert.ok(errors.length); assert.ok((await a.syncSummary(w.workspaceId)).pending > 0);
    const restored = await recoverArchive(archive, join(directory, "next"), true);
    next = await startWorkspaceServer({ directory: restored.target, token });
    assert.equal((await call(next.url, "migration-status")).state, "prepared");
    assert.equal((await call(next.url, "migration-activate")).state, "active");
    const denied = await fetch(next.url + "/v1/mcp/tools", { method: "POST", headers: { authorization: "Bearer " + oldGrant.credential }, body: "{}" });
    assert.equal(denied.ok, false);
    await new SyncEngine(w, a, new HttpSyncRemote(next.url, token), policies).run();
    assert.equal((await a.syncSummary(w.workspaceId)).pending, 0);
    const targetStore = await SqliteLocalStore.open({ databasePath: restored.databasePath });
    try { assert.equal((await targetStore.authorityRead(scope))?.value?.text, "迁移后接续"); }
    finally { await targetStore.close(); }
    assert.equal((await call(old.url, "migration-status")).state, "stopped");
    await assert.rejects(call(old.url, "migration-activate", { isolated: true }));
    const currentRecord = (await a.readRecord(scope))!;
    await new ExistingContentService(a).mutate({ ...scope, operationId: "delete-after-migration" }, currentRecord.localSequence, value => prepareTodoMutation(value, { kind: "delete", confirmed: true }, new Date().toISOString()));
    await new SyncEngine(w, a, new HttpSyncRemote(next.url, token), policies).run();
    const stale = await recoverArchive(earlyLocal, join(directory, "stale-local"), true);
    const staleStore = await SqliteLocalStore.open({ databasePath: stale.databasePath });
    try {
      await new SyncEngine(w, staleStore, new HttpSyncRemote(next.url, token), policies).run();
      assert.equal((await staleStore.readRecord(scope))?.deleted, true);
      assert.equal((await staleStore.syncSummary(w.workspaceId)).pending, 0);
    } finally { await staleStore.close(); }
    const localArchive = { workspace: w, location: old.url, snapshot: await a.snapshot(w.workspaceId, "local") };
    const promoted = await recoverArchive(authorityFromLocal(localArchive), join(directory, "promoted"), true);
    const promotedStore = await SqliteLocalStore.open({ databasePath: promoted.databasePath });
    try {
      await assert.rejects(promotedStore.authorityControl(w.workspaceId, w.authorityId, "activate"));
      assert.equal((await promotedStore.authorityControl(w.workspaceId, w.authorityId, "activate", true)).state, "active");
      const page = await promotedStore.authorityPull(w.workspaceId, localArchive.snapshot.revisionFloor);
      assert.equal(page.more, false);
    } finally { await promotedStore.close(); }
  } finally { await a.close(); await authority?.close(); await next?.close(); await old.close(); await rm(directory, { recursive: true, force: true }); }
});
