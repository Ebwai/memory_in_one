import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { startWorkspaceServer } from "@workspace/server/initialization";
import { WorkspaceInitialization, DomainRegistry, SyncEngine, ExistingContentService } from "@workspace/core";
import { HttpWorkspaceLocation, SqliteLocalStore, FileExtensionPrograms, HttpSyncRemote } from "@workspace/adapters";
import { todoDefinition, todoConflictPolicy, prepareTodoMutation } from "@workspace/todo-list";

test("N49 real external stdio MCP client discovers, writes, confirms deletion and obeys revocation", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-stdio-"));
  const owner = "o".repeat(40);
  const server = await startWorkspaceServer({ directory: join(directory, "authority"), token: owner });
  const clients = [];
  async function ownerCall(method, input = {}) {
    const response = await fetch(server.url + "/v1/mcp/" + method, { method: "POST", headers: { authorization: "Bearer " + owner }, body: JSON.stringify(input) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  }
  async function connect(credential, elicitation) {
    const client = new Client({ name: "external-acceptance-client", version: "1.0.0" }, { capabilities: elicitation ? { elicitation: { form: {} } } : {} });
    if (elicitation) client.setRequestHandler(ElicitRequestSchema, async request => {
      assert.match(request.params.message, /确认删除/); assert.match(request.params.message, /原任务/);
      return { action: "accept", content: { approve: true } };
    });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("apps/mcp/protocol/main.mjs")], env: { ...process.env, WORKSPACE_MCP_URL: server.url, WORKSPACE_MCP_TOKEN: credential }, stderr: "pipe" });
    await client.connect(transport); clients.push(client); return client;
  }
  const invoke = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  try {
    const init = await new WorkspaceInitialization(new HttpWorkspaceLocation(server.url, owner), randomUUID, () => "2026-10-26T00:00:00Z").create({ creationId: "stdio", name: "外部接入" });
    assert.equal(init.status, "created");
    const store = await SqliteLocalStore.open({ databasePath: join(directory, "replica.sqlite") });
    try {
      const registry = new DomainRegistry(init.workspace.workspaceId, store, new FileExtensionPrograms(join(directory, "programs")));
      await registry.register(todoDefinition, "register"); await registry.setEnabled("builtin.todo", true, "enable");
      await new SyncEngine(init.workspace, store, new HttpSyncRemote(server.url, owner), d => d === "builtin.todo" ? todoConflictPolicy : { attributes: { enabled: ["enabled"] }, validate() {} }).run();
    } finally { await store.close(); }
    const grant = await ownerCall("grant-create", { name: "真实外部客户端", domains: ["builtin.todo"], actions: ["read", "create", "update", "delete", "directory", "enable", "disable"] });
    const client = await connect(grant.credential, true);
    const tools = (await client.listTools()).tools.map(t => t.name);
    assert.ok(tools.includes("content_create")); assert.ok(tools.includes("domain_directory")); assert.ok(!tools.includes("content_complete"));
    const input = { domainId: "builtin.todo", operationId: "original", text: "原任务" };
    const created = await invoke(client, "content_create", input);
    assert.equal(created.status, "accepted");
    assert.deepEqual(await invoke(client, "content_create", input), created);
    assert.equal((await invoke(client, "content_list", { domainId: "builtin.todo" })).records.length, 1);
    const human = await SqliteLocalStore.open({ databasePath: join(directory, "replica.sqlite") });
    try {
      const engine = new SyncEngine(init.workspace, human, new HttpSyncRemote(server.url, owner), d => d === "builtin.todo" ? todoConflictPolicy : { attributes: { enabled: ["enabled"] }, validate() {} });
      await engine.pull();
      const scope = { workspaceId: init.workspace.workspaceId, domainId: "builtin.todo", recordId: created.version.recordId };
      const record = await human.readRecord(scope);
      assert.equal(record.payload.text, "原任务");
      await new ExistingContentService(human).mutate({ ...scope, operationId: "human-edit" }, record.localSequence, value => prepareTodoMutation(value, { kind: "text", text: "人工推进原任务" }, "2026-10-26T02:00:00Z"));
      await engine.run();
    } finally { await human.close(); }
    const conflict = await invoke(client, "content_update", { domainId: "builtin.todo", recordId: created.version.recordId, revision: created.version.revision, text: "不能覆盖人工成果", operationId: "stale-agent" });
    assert.equal(conflict.status, "conflict");
    const current = await invoke(client, "content_get", { domainId: "builtin.todo", recordId: created.version.recordId });
    assert.equal(current.record.value.text, "人工推进原任务");
    const result = await invoke(client, "content_delete", { domainId: "builtin.todo", recordId: created.version.recordId, revision: current.record.revision, operationId: "delete" });
    assert.equal(result.status, "accepted", JSON.stringify(result));
    assert.equal((await invoke(client, "call_status", { operationId: "delete" })).status, "succeeded");
    const fallback = await connect(grant.credential, false);
    const second = await invoke(fallback, "content_create", { ...input, operationId: "second" });
    const deleteInput = { domainId: "builtin.todo", recordId: second.version.recordId, revision: second.version.revision, operationId: "fallback-delete" };
    const pending = await invoke(fallback, "content_delete", deleteInput);
    assert.equal(pending.status, "pending-confirmation"); assert.match(pending.confirmationUrl, /\/manage#confirmation=/);
    const confirmation = await ownerCall("confirmation", { operationId: pending.operationId }); assert.ok(confirmation.object.includes("原任务"));
    await ownerCall("owner-confirmation", { operationId: pending.operationId, accepted: true });
    assert.equal((await invoke(fallback, "content_delete", deleteInput)).status, "accepted");
    const readOnly = await ownerCall("grant-create", { name: "只读", domains: ["builtin.todo"] });
    const reader = await connect(readOnly.credential, false);
    assert.deepEqual((await reader.listTools()).tools.map(t => t.name).sort(), ["call_status", "content_get", "content_list"]);
    await ownerCall("grant-revoke", { id: grant.grant.id });
    assert.equal((await invoke(client, "content_create", { ...input, operationId: "after-revoke" })).status, "rejected");
    assert.equal((await ownerCall("calls")).filter(c => c.action === "delete" && c.status === "succeeded").length, 2);
  } finally { await Promise.all(clients.map(c => c.close())); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
