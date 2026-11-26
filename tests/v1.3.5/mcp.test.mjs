import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DomainRegistry, SyncEngine, WorkspaceInitialization } from '../../packages/core/dist/index.js';
import { HttpSyncRemote, HttpWorkspaceLocation, FileExtensionPrograms, SqliteLocalStore } from '../../packages/adapters/dist/index.js';
import { presetDefinition } from '../../packages/contracts/dist/index.js';
import { todoDefinition } from '../../packages/todo-list/dist/index.js';
import { startWorkspaceServer } from '../../apps/server/dist/transport/server.js';
import { startCodexBroker, configureCodex } from '../../apps/desktop/dist/host/mcp-codex.js';

const root = resolve('tests/v1.3.5/artifacts');
await mkdir(root, { recursive: true });
test('actual MCP stdio exposes distinct CRUD tools and supports modes, filters, projection and retry', { timeout: 120000 }, async () => {
  const dir = join(root, 'service-' + Date.now());
  const token = randomUUID() + randomUUID();
  const service = await startWorkspaceServer({ directory: join(dir, 'authority'), token });
  const store = await SqliteLocalStore.open({ databasePath: join(dir, 'replica.sqlite') });
  let client;
  try {
    const created = await new WorkspaceInitialization(new HttpWorkspaceLocation(service.url, token), randomUUID, () => new Date().toISOString()).create({ creationId: randomUUID(), name: 'MCP 1.3.5 QA' });
    assert.equal(created.status, 'created');
    const registry = new DomainRegistry(created.workspace.workspaceId, store, new FileExtensionPrograms(join(dir, 'programs')));
    for (const definition of [todoDefinition, presetDefinition('preset.notes')]) {
      await registry.register(definition, 'register-' + definition.domainId);
      await registry.setEnabled(definition.domainId, true, 'enable-' + definition.domainId);
    }
    const policy = domain => ({ attributes: domain === 'system.domains' ? { enabled: ['enabled', 'removed'], program: ['definition', 'fingerprint'] } : {}, validate: () => undefined });
    assert.deepEqual(await new SyncEngine(created.workspace, store, new HttpSyncRemote(service.url, token), policy).run(), []);
    const response = await fetch(service.url + '/v1/mcp/grant-create', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'QA', domains: ['*'], actions: ['read', 'create', 'update', 'delete', 'delete-unattended', 'complete', 'restore', 'date', 'directory'] }) });
    const grant = await response.json();
    client = new Client({ name: 'v1.3.5 QA', version: '1.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [process.env.WORKSPACE_TEST_MCP_ENTRY ?? resolve('apps/mcp/protocol/main.mjs')], env: { ...process.env, WORKSPACE_MCP_URL: service.url, WORKSPACE_MCP_TOKEN: grant.credential } }));
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    for (const prefix of ['todo', 'note']) assert.deepEqual(tools.filter(name => name.startsWith(prefix + '_')).sort(), ['create', 'delete', 'query', 'update'].map(action => prefix + '_' + action).sort());
    assert.ok(!tools.includes('content_list') && !tools.includes('content_date'));
    async function call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const value = JSON.parse(result.content[0].text);
      if (result.isError) throw new Error(JSON.stringify(value));
      return value;
    }
    const first = await call('todo_create', { operationId: 'parent', text: '前置任务' });
    const parent = first.version;
    const second = await call('todo_create', { operationId: 'child', text: '检索任务', prerequisiteId: parent.recordId, notes: '关键字 QA', dueDate: '2026-12-01', frequency: 'week', target: 2, timezone: 'Asia/Shanghai' });
    assert.equal(second.status, 'accepted');
    let task = second.version;
    await assert.rejects(call('todo_update', { operationId: 'blocked', recordId: task.recordId, revision: task.revision, mode: 'completion', completed: true }), /前置/);
    assert.equal((await call('todo_update', { operationId: 'parent-done', recordId: parent.recordId, revision: parent.revision, mode: 'completion', completed: true })).status, 'accepted');
    const changed = await call('todo_update', { operationId: 'all-fields', recordId: task.recordId, revision: task.revision, mode: 'all', text: '新检索任务', notes: '关键字 QA', dueDate: '2026-12-02', prerequisiteId: parent.recordId, frequency: null, completed: true });
    assert.equal(changed.status, 'accepted');
    task = changed.version;
    const query = await call('todo_query', { status: 'completed', keyword: '关键字', timeField: 'dueDate', start: '2026-12-01T00:00', end: '2026-12-03T00:00', fields: ['text', 'dueDate'] });
    assert.equal(query.records.length, 1);
    assert.deepEqual(Object.keys(query.records[0]).sort(), ['recordId', 'revision', 'text', 'dueDate'].sort());
    const noteArgs = { operationId: 'note-create', title: '标题', text: '正文' };
    const note = await call('note_create', noteArgs);
    assert.equal((await call('note_create', noteArgs)).version.revision, note.version.revision);
    const updateArgs = { operationId: 'note-update', recordId: note.version.recordId, revision: note.version.revision, title: '修改标题' };
    const edited = await call('note_update', updateArgs);
    assert.equal((await call('note_update', updateArgs)).version.revision, edited.version.revision);
    assert.equal((await call('note_query', { keyword: '修改标题', fields: ['title'] })).records[0].title, '修改标题');
    assert.equal((await call('note_delete', { operationId: 'note-delete', recordId: edited.version.recordId, revision: edited.version.revision })).status, 'accepted');
    assert.equal((await call('todo_delete', { operationId: 'todo-delete', recordId: task.recordId, revision: task.revision })).status, 'accepted');
  } finally { await client?.close(); await store.close(); await service.close(); }
});

test('broker discovers future spaces, requires workspace selection and writes isolated Codex user configuration', { timeout: 30000 }, async () => {
  const dir = join(root, 'broker-' + Date.now());
  await mkdir(dir, { recursive: true });
  const spaces = [{ workspace: { workspaceId: 'first', name: 'First' }, endpoint: '' }];
  const descriptor = join(dir, 'broker.json');
  const stop = await startCodexBroker({ descriptor, spaces: () => spaces, remote: async (space, method) => method === 'tools' ? { domains: ['builtin.todo'], capabilities: {} } : { workspaceId: space.workspace.workspaceId } });
  const savedHome = process.env.CODEX_HOME;
  try {
    const info = JSON.parse(await readFile(descriptor, 'utf8'));
    const request = (method, input = {}, token = info.credential) => fetch(info.endpoint + '/v1/mcp/' + method, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(input) });
    assert.equal((await request('tools', {}, 'invalid')).status, 401);
    assert.equal((await (await request('spaces')).json()).length, 1);
    spaces.push({ workspace: { workspaceId: 'later', name: 'Later' }, endpoint: '' });
    assert.equal((await (await request('spaces')).json()).length, 2);
    assert.equal((await request('list')).status, 400);
    assert.equal((await (await request('list', { workspaceId: 'later' })).json()).workspaceId, 'later');
    process.env.CODEX_HOME = join(dir, 'codex-home');
    await mkdir(process.env.CODEX_HOME, { recursive: true });
    await configureCodex(process.execPath, resolve('apps/mcp/protocol/main.mjs'), descriptor);
    const config = await readFile(join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.ok(config.includes('[mcp_servers.todo_workspace]') && config.includes('WORKSPACE_MCP_DESCRIPTOR'));
  } finally {
    if (savedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedHome;
    await stop();
  }
});
