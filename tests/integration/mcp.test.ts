import { startWorkspaceServer } from "@workspace/server/initialization";
import { todoDefinition, todoConflictPolicy } from "@workspace/todo-list";
import { DomainRegistry, SyncEngine } from "@workspace/core";
import { FileExtensionPrograms, HttpSyncRemote } from "@workspace/adapters";
import { HttpWorkspaceLocation } from "@workspace/adapters";
import { WorkspaceInitialization } from "@workspace/core";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { McpAccess } from "@workspace/core";
import { SqliteLocalStore } from "@workspace/adapters";
import type { McpCall, UploadRequest } from "@workspace/contracts";

test("N44 call records survive restart, deduplicate and commit atomically with authority facts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-mcp-"));
  const databasePath = join(directory, "store.sqlite");
  let store = await SqliteLocalStore.open({ databasePath });
  const audit: McpCall = { workspaceId: "w", operationId: "op", sourceId: "grant", sourceName: "测试客户端", domainId: "notes", action: "create", recordId: "r", summary: "创建内容 r", time: "2026-10-26T00:00:00Z", confirmed: false, status: "unconfirmed", result: {} };
  const request: UploadRequest = { workspaceId: "w", authorityId: "a", operationId: "op", domainId: "notes", recordId: "r", baseRevision: 0, value: { text: "hello" }, changed: [], resolution: false, audit };
  try {
    await new McpAccess("w", store, () => audit.time).create("grant", "测试客户端", ["notes"], ["create"], "a".repeat(64));
    await store.mcp({ method: "call-save", call: audit });
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TRIGGER fail_audit BEFORE UPDATE ON mcp_calls BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    await assert.rejects(store.authorityCommit(request, request.value, 0, [], []));
    assert.equal(await store.authorityRead(request), null);
    db.exec("DROP TRIGGER fail_audit"); db.close();
    const result = await store.authorityCommit(request, request.value, 0, [], []);
    assert.equal(result?.status, "accepted");
    assert.deepEqual(await store.authorityCommit(request, request.value, 0, [], []), result);
    await store.close(); store = await SqliteLocalStore.open({ databasePath });
    const calls = await store.mcp<McpCall[]>({ method: "call-list", workspaceId: "w", sourceId: "grant" });
    assert.equal(calls.length, 1); assert.equal(calls[0]?.status, "succeeded");
    assert.equal(calls[0]?.sourceName, "测试客户端");
    await assert.rejects(store.mcp({ method: "call-save", call: { ...audit, recordId: "other" } }));
    assert.deepEqual(await store.mcp({ method: "call-list", workspaceId: "other" }), []);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("N45 grants default to read, isolate domains and revoke before transaction commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-grant-"));
  const store = await SqliteLocalStore.open({ databasePath: join(directory, "store.sqlite") });
  const access = new McpAccess("w", store, () => "2026-10-26T00:00:00Z");
  try {
    const grant = await access.create("g", "只读来源", ["notes"], undefined, "b".repeat(64));
    assert.deepEqual(grant.actions, ["read"]);
    access.require(await access.authenticate("b".repeat(64)), "notes", "read");
    assert.throws(() => access.require(grant, "notes", "create"));
    assert.throws(() => access.require(grant, "other", "read"));
    await assert.rejects(access.authenticate("c".repeat(64)));
    const writer = await access.create("writer", "写来源", ["notes"], ["create"], "d".repeat(64));
    access.require(writer, "notes", "create");
    await access.revoke("writer");
    const audit: McpCall = { workspaceId: "w", operationId: "late", sourceId: "writer", sourceName: writer.name, domainId: "notes", action: "create", recordId: "r", summary: "r", time: "", confirmed: false, status: "unconfirmed", result: {} };
    const request: UploadRequest = { workspaceId: "w", authorityId: "a", domainId: "notes", recordId: "r", operationId: "late", baseRevision: 0, value: { text: "late" }, changed: [], resolution: false, audit };
    await assert.rejects(store.authorityCommit(request, request.value, 0, [], []));
    assert.equal(await store.authorityRead(request), null);
    await assert.rejects(access.authenticate("d".repeat(64)));
    const calls = await store.mcp<McpCall[]>({ method: "call-list", workspaceId: "w" });
    assert.equal(calls.filter(c => c.action === "grant-revoke").length, 1);
    assert.equal(JSON.stringify(calls).includes("d".repeat(64)), false);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("N46–N48 real HTTP queries, writes, confirmations and independent domain lifecycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-mcp-query-"));
  const owner = "o".repeat(40);
  const server = await startWorkspaceServer({ directory, token: owner });
  try {
    const init = await new WorkspaceInitialization(new HttpWorkspaceLocation(server.url, owner), randomUUID, () => "2026-10-26T00:00:00Z").create({ creationId: "query", name: "MCP" });
    assert.equal(init.status, "created");
    if (init.status !== "created") throw new Error("init failed");
    const replica = await SqliteLocalStore.open({ databasePath: join(directory, "replica.sqlite") });
    try {
      const registry = new DomainRegistry(init.workspace.workspaceId, replica, new FileExtensionPrograms(join(directory, "programs")));
      await registry.register(todoDefinition, "register"); await registry.setEnabled("builtin.todo", true, "enable");
      await new SyncEngine(init.workspace, replica, new HttpSyncRemote(server.url, owner), domain => domain === "builtin.todo" ? todoConflictPolicy : { attributes: { enabled: ["enabled"] }, validate: () => undefined }).run();
    } finally { await replica.close(); }
    const authorization = await (await fetch(server.url + "/v1/mcp/grant-create", { method: "POST", headers: { authorization: "Bearer " + owner }, body: JSON.stringify({ name: "只读", domains: ["builtin.todo"] }) })).json() as { credential: string };
    assert.ok(authorization.credential, JSON.stringify(authorization));
    const query = async (method: string, body: object, token = authorization.credential) => {
      const response = await fetch(server.url + "/v1/mcp/" + method, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
      return { code: response.status, body: await response.json() as any };
    };
    const empty = await query("list", { domainId: "builtin.todo" });
    assert.equal(empty.code, 200, JSON.stringify(empty.body)); assert.deepEqual(empty.body.records, []);
    assert.equal(empty.body.source, "authority-confirmed");
    assert.equal((await query("get", { domainId: "builtin.todo", recordId: "missing" })).body.status, "not-found");
    assert.equal((await query("list", { domainId: "other" })).code, 403);
    assert.equal((await query("list", { domainId: "builtin.todo" }, "bad")).code, 403);
    const writer = await (await fetch(server.url + "/v1/mcp/grant-create", { method: "POST", headers: { authorization: "Bearer " + owner }, body: JSON.stringify({ name: "写来源", domains: ["builtin.todo"], actions: ["read", "create", "update", "complete", "restore", "date", "delete"] }) })).json() as { credential: string };
    const createInput = { domainId: "builtin.todo", action: "create", text: "MCP 原任务", operationId: "create-one" };
    const created = await query("write", createInput, writer.credential);
    assert.equal(created.body.status, "accepted", JSON.stringify(created.body));
    assert.deepEqual((await query("write", createInput, writer.credential)).body, created.body);
    assert.equal((await query("list", { domainId: "builtin.todo" })).body.records.length, 1);
    const version = created.body.version;
    const completed = await query("write", { domainId: "builtin.todo", recordId: version.recordId, revision: version.revision, action: "complete", operationId: "done" }, writer.credential);
    assert.equal(completed.body.status, "accepted");
    const records = (await query("list", { domainId: "builtin.todo" })).body.records;
    assert.equal(records[0].value.completed, true);
    const stale = await query("write", { domainId: "builtin.todo", recordId: version.recordId, revision: version.revision, action: "update", text: "独立字段", operationId: "merge" }, writer.credential);
    assert.equal(stale.body.status, "accepted");
    assert.equal(stale.body.version.value.completed, true);
    const deletion = { domainId: "builtin.todo", recordId: version.recordId, revision: stale.body.version.revision, action: "delete", operationId: "delete" };
    assert.equal((await query("write", { ...deletion, confirmed: true }, writer.credential)).code, 403);
    const pending = (await query("write", deletion, writer.credential)).body;
    assert.equal(pending.status, "pending-confirmation");
    assert.equal((await query("list", { domainId: "builtin.todo" })).body.records.length, 1);
    assert.equal((await query("respond-confirmation", { operationId: pending.operationId, challenge: pending.challenge, accepted: true }, writer.credential)).code, 200);
    assert.equal((await query("write", deletion, writer.credential)).body.status, "accepted");
    assert.equal((await query("list", { domainId: "builtin.todo" })).body.records.length, 0);
    const status = (await query("status", { operationId: "delete" }, writer.credential)).body;
    assert.equal(status.status, "succeeded"); assert.ok(status.summary.includes("独立字段"));
    assert.equal((await query("status", { operationId: pending.operationId })).body.status, "not-found");
    assert.equal((await query("write", createInput)).code, 403);
    const another = (await query("write", { ...createInput, operationId: "confirmation-change" }, writer.credential)).body.version;
    const obsoleteDelete = { domainId: "builtin.todo", recordId: another.recordId, revision: another.revision, action: "delete", operationId: "obsolete-delete" };
    const obsolete = (await query("write", obsoleteDelete, writer.credential)).body;
    const changed = (await query("write", { domainId: "builtin.todo", recordId: another.recordId, revision: another.revision, action: "update", text: "确认前的新进度", operationId: "change-before-confirm" }, writer.credential)).body;
    assert.equal(changed.status, "accepted");
    assert.notEqual((await query("respond-confirmation", { operationId: obsolete.operationId, challenge: obsolete.challenge, accepted: true }, writer.credential)).code, 200);
    assert.equal((await query("write", obsoleteDelete, writer.credential)).body.status, "pending-confirmation");
    assert.equal((await query("get", { domainId: "builtin.todo", recordId: another.recordId })).body.record.value.text, "确认前的新进度");
    const authorityScope = (await query("export-scope", {}, owner)).body;
    assert.equal(authorityScope.source, "authority"); assert.ok(authorityScope.domains.some((d: any) => d.domainId === "builtin.todo"));
    assert.equal((await query("export-scope", {}, writer.credential)).code, 403);
    const manager = await (await fetch(server.url + "/v1/mcp/grant-create", { method: "POST", headers: { authorization: "Bearer " + owner }, body: JSON.stringify({ name: "领域管理", domains: ["builtin.todo"], actions: ["directory", "enable", "disable"] }) })).json() as { credential: string };
    const directoryEntries = (await query("directory", {}, manager.credential)).body;
    assert.equal(directoryEntries[0].programTarget, "server");
    const disabled = await query("write", { domainId: "builtin.todo", action: "disable", revision: directoryEntries[0].revision, operationId: "disable" }, manager.credential);
    assert.equal(disabled.body.status, "accepted", JSON.stringify(disabled.body));
    assert.equal((await query("list", { domainId: "builtin.todo" })).code, 403);
    assert.equal((await query("write", { domainId: "builtin.todo", action: "enable", revision: disabled.body.version.revision, operationId: "enable" }, manager.credential)).body.status, "accepted");
    assert.equal((await query("directory", {}, writer.credential)).code, 403);
    const definition = JSON.parse(await readFile("extensions/sample-independent-domain/extension.json", "utf8"));
    const custom = await (await fetch(server.url + "/v1/mcp/grant-create", { method: "POST", headers: { authorization: "Bearer " + owner }, body: JSON.stringify({ name: "阅读管理", domains: ["example.reading"], actions: ["directory", "register", "enable", "disable", "install", "remove", "read", "create", "update", "delete"] }) })).json() as { credential: string };
    const registered = (await query("write", { domainId: "example.reading", action: "register", definition, operationId: "register-reading" }, custom.credential)).body;
    assert.equal(registered.status, "accepted", JSON.stringify(registered));
    const enabled = (await query("write", { domainId: "example.reading", action: "enable", revision: registered.version.revision, operationId: "enable-reading" }, custom.credential)).body;
    assert.equal(enabled.status, "accepted");
    const customCreated = (await query("write", { domainId: "example.reading", action: "create", payload: { quote: "原文", book: "书" }, operationId: "custom-create" }, custom.credential)).body;
    assert.equal(customCreated.status, "accepted");
    assert.equal(Object.hasOwn(customCreated.version.value, "completed"), false);
    assert.equal((await query("program", { domainId: "example.reading", action: "remove", target: "desktop", operationId: "wrong-target" }, custom.credential)).body.status, "unavailable");
    assert.equal((await query("program", { domainId: "example.reading", action: "remove", target: "server", operationId: "remove" }, custom.credential)).body.status, "succeeded");
    assert.equal((await query("list", { domainId: "example.reading" }, custom.credential)).code, 403);
    const unavailable = (await query("directory", {}, custom.credential)).body;
    assert.equal(unavailable[0].programAvailable, false);
    assert.equal((await query("program", { domainId: "example.reading", action: "install", target: "server", definition, operationId: "restore-program" }, custom.credential)).body.status, "succeeded");
    assert.equal((await query("list", { domainId: "example.reading" }, custom.credential)).body.records[0].value.book, "书");
    assert.equal((await query("list", { domainId: "builtin.todo" })).code, 200);
    assert.equal((await query("grant-create", { name: "expand", domains: ["builtin.todo"], actions: ["delete"] })).code, 403);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("N44–N45 existing v4 files upgrade to v5 without changing local work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-mcp-upgrade-"));
  const databasePath = join(directory, "replica.sqlite");
  let store = await SqliteLocalStore.open({ databasePath });
  try {
    await store.commit({ workspaceId: "w", domainId: "notes", recordId: "r", operationId: "old", kind: "put", payloadJson: '{"text":"原成果"}' });
    await store.close();
    const db = new DatabaseSync(databasePath);
    db.exec("DROP TABLE mcp_calls; DROP TABLE mcp_grants; DROP TABLE mcp_requests; DROP TABLE mcp_host_programs; PRAGMA user_version=4");
    db.close();
    store = await SqliteLocalStore.open({ databasePath });
    assert.equal((await store.readRecord({ workspaceId: "w", domainId: "notes", recordId: "r" }))?.payload?.text, "原成果");
    assert.deepEqual(await store.mcp({ method: "grant-list", workspaceId: "w" }), []);
    assert.equal((await store.listPending({ workspaceId: "w", domainId: "notes" })).length, 1);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
