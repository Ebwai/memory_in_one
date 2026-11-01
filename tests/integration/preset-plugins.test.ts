import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainRegistry } from "@workspace/core";
import { FileExtensionPrograms, SqliteLocalStore } from "@workspace/adapters";
import { NOTES_DOMAIN, presetDefinition, matchesPreset, validatePresetRecord } from "@workspace/contracts";
import { parseExtension, validateExtensionRecord } from "@workspace/extension-sdk";
const { WorkspaceSync } = await import(new URL("../composition/workspace-sync.js", import.meta.resolve("@workspace/server/initialization")).href);
import { createHash } from "node:crypto";
import { startWorkspaceServer } from "@workspace/server/initialization";
import { HttpSyncRemote, HttpWorkspaceLocation } from "@workspace/adapters";
import { SyncEngine, WorkspaceInitialization } from "@workspace/core";
import { randomUUID } from "node:crypto";

test("preset instances remain isolated through rename, deletion, restart and authority validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preset-plugins-"));
  const databasePath = join(directory, "replica.sqlite");
  const programs = new FileExtensionPrograms(join(directory, "programs"));
  let store = await SqliteLocalStore.open({ databasePath });
  try {
    let registry = new DomainRegistry("space", store, programs);
    for (const id of [NOTES_DOMAIN, "preset.project.first", "preset.project.second"]) {
      const definition = presetDefinition(id);
      assert.ok(matchesPreset(parseExtension(JSON.stringify(definition))));
      await registry.register(definition, id + "-register");
      await registry.setEnabled(id, true, id + "-enable");
      if (id !== NOTES_DOMAIN) await registry.manageProject(id, id + "-name", "同名项目");
      const content = await registry.contentStore(id);
      const payload = { text: id, createdAt: "2026-11-01T00:00:00.000Z", ...(id === NOTES_DOMAIN ? {} : { kind: "idea", completed: false }) };
      validateExtensionRecord(definition, payload); validatePresetRecord(id, payload);
      await content.commit({ workspaceId: "space", domainId: id, recordId: "same-record", operationId: id + "-content", kind: "put", payloadJson: JSON.stringify(payload) }, null);
      await assert.rejects(content.listRecords({ workspaceId: "space", domainId: "builtin.todo" }), /无权/);
    }
    await registry.manageProject("preset.project.first", "rename", "新的名称");
    await registry.manageProject("preset.project.first", "rename", "新的名称");
    assert.equal((await registry.get("preset.project.second")).displayName, "同名项目");
    assert.equal((await store.listRecords({ workspaceId: "space", domainId: "builtin.todo" })).length, 0);
    const registration = await store.readRecord({ workspaceId: "space", domainId: "system.domains", recordId: "preset.project.first" });
    const authority = await new WorkspaceSync(directory).handler(store, "space", "system.domains");
    authority.validate(registration!.payload, null, true);
    assert.throws(() => validatePresetRecord(NOTES_DOMAIN, { text: "  ", createdAt: "bad" }));
    const spoof = { ...presetDefinition(NOTES_DOMAIN), name: "fake" };
    assert.throws(() => authority.validate({ definition: spoof as unknown as import("@workspace/contracts").JsonObject, fingerprint: createHash("sha256").update(JSON.stringify(spoof)).digest("hex"), enabled: true }, null, true), /不匹配/);
    await registry.manageProject("preset.project.first", "delete", null);
    await registry.manageProject("preset.project.first", "delete", null);
    await assert.rejects(registry.contentStore("preset.project.first"), /尚未登记/);
    await assert.rejects(registry.register(presetDefinition("preset.project.first"), "resurrect"), /已删除/);
    await store.close(); store = await SqliteLocalStore.open({ databasePath });
    registry = new DomainRegistry("space", store, programs);
    assert.equal((await registry.list()).length, 2);
    assert.equal((await (await registry.contentStore(NOTES_DOMAIN)).listRecords({ workspaceId: "space", domainId: NOTES_DOMAIN }))[0]?.payload?.text, NOTES_DOMAIN);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("shipped presets synchronize without server program installation and deletion blocks old clients", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preset-sync-"));
  const token = "preset-owner-secret-01234567890123456789";
  const server = await startWorkspaceServer({ directory: join(directory, "server"), token });
  const a = await SqliteLocalStore.open({ databasePath: join(directory, "a.sqlite") });
  const b = await SqliteLocalStore.open({ databasePath: join(directory, "b.sqlite") });
  try {
    const result = await new WorkspaceInitialization(new HttpWorkspaceLocation(server.url, token), randomUUID, () => new Date().toISOString()).create({ creationId: "preset-create", name: "预设同步" });
    assert.equal(result.status, "created");
    if (result.status !== "created") throw new Error("初始化失败");
    const identity = result.workspace;
    const registry = new DomainRegistry(identity.workspaceId, a, new FileExtensionPrograms(join(directory, "programs")));
    const id = "preset.project.shared";
    await registry.register(presetDefinition(id), "register");
    await registry.manageProject(id, "name", "跨设备项目");
    await registry.setEnabled(id, true, "enable");
    const content = await registry.contentStore(id);
    await content.commit({ workspaceId: identity.workspaceId, domainId: id, recordId: "idea", operationId: "content", kind: "put", payloadJson: JSON.stringify({ kind: "idea", text: "共同想法", completed: false, createdAt: "2026-11-01T00:00:00Z" }) }, null);
    const policy = (domain: string) => ({ attributes: domain === "system.domains" ? { enabled: ["enabled", "removed"], name: ["displayName"], program: ["definition", "fingerprint"] } : {}, validate: () => undefined });
    const remote = new HttpSyncRemote(server.url, token);
    const engine = new SyncEngine(identity, a, remote, policy);
    assert.deepEqual(await engine.run(), []);
    assert.deepEqual(await new SyncEngine(identity, b, remote, policy).run(), []);
    const other = new DomainRegistry(identity.workspaceId, b, new FileExtensionPrograms(join(directory, "other-programs")));
    assert.equal((await other.get(id)).displayName, "跨设备项目");
    assert.equal((await b.listRecords({ workspaceId: identity.workspaceId, domainId: id }))[0]?.payload?.text, "共同想法");
    await registry.manageProject(id, "delete", null);
    assert.deepEqual(await engine.run(), []);
    assert.deepEqual(await new SyncEngine(identity, b, remote, policy).run(), []);
    assert.equal((await other.list()).length, 0);
    await assert.rejects(other.contentStore(id));
  } finally { await a.close(); await b.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
