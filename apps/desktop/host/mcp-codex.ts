import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFile, readFile, access } from 'node:fs/promises';
import type { JsonObject, WorkspaceIdentity } from '@workspace/contracts';
import { MCP_ACTIONS } from '@workspace/core';

export interface McpWorkspace { workspace: WorkspaceIdentity; endpoint: string }

export async function startCodexBroker(options: {
  descriptor: string;
  spaces(): McpWorkspace[];
  remote(space: McpWorkspace, method: string, input: JsonObject): Promise<any>;
}) {
  const credential = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    response.setHeader('cache-control', 'no-store');
    const expected = Buffer.from('Bearer ' + credential);
    const actual = Buffer.from(request.headers.authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { response.writeHead(401); response.end('{}'); return; }
    try {
      if (request.method !== 'POST' || !request.url?.startsWith('/v1/mcp/')) throw new Error('无效请求。');
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        length += Buffer.byteLength(chunk);
        if (length > 8 * 1024 * 1024) throw new Error('请求过大。');
        chunks.push(Buffer.from(chunk));
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonObject;
      const spaces = options.spaces();
      const method = request.url.slice('/v1/mcp/'.length);
      let result: unknown;
      if (method === 'spaces') result = spaces.map(space => ({ workspaceId: space.workspace.workspaceId, name: space.workspace.name }));
      else if (method === 'tools') {
        const states = await Promise.allSettled(spaces.map(space => options.remote(space, 'tools', {})));
        const infos = states.flatMap(state => state.status === 'fulfilled' && state.value.domains ? [state.value] : []);
        const capabilities: Record<string, string[]> = {};
        for (const info of infos) for (const [id, actions] of Object.entries(info.capabilities ?? {})) capabilities[id] = [...new Set([...(capabilities[id] ?? []), ...(actions as string[])])];
        result = { contentProtocol: 2, workspaces: spaces.map((space, index) => ({ workspaceId: space.workspace.workspaceId, name: space.workspace.name, available: states[index]?.status === 'fulfilled' })),
          domains: [...new Set(infos.flatMap(info => info.domains))], capabilities, authorizedDomains: ['*'], grant: { actions: MCP_ACTIONS } };
      } else {
        const space = input.workspaceId ? spaces.find(space => space.workspace.workspaceId === input.workspaceId) : spaces.length === 1 ? spaces[0] : undefined;
        if (!space) throw new Error('请先调用 workspace_list，明确选择 workspaceId。');
        const { workspaceId: _workspaceId, ...parameters } = input;
        result = await options.remote(space, method, parameters);
      }
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400); response.end(JSON.stringify({ status: 'rejected', message: error instanceof Error ? error.message : 'MCP 请求失败。' }));
    }
  });
  server.requestTimeout = 20000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本机 MCP 地址不可用。');
  const temporary = options.descriptor + '.tmp';
  await writeFile(temporary, JSON.stringify({ endpoint: 'http://127.0.0.1:' + address.port, credential }), { mode: 0o600 });
  const { rename } = await import('node:fs/promises');
  await rename(temporary, options.descriptor);
  return () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
}

export async function configureCodex(executable: string, entry: string, descriptor: string): Promise<string> {
  // Codex's CLI updates its own user-level TOML and preserves unrelated settings.
  await readFile(descriptor);
  let command = 'codex';
  if (process.platform === 'win32') {
    command = await new Promise<string>((resolve, reject) => {
      const script = "$command = Get-Command codex.exe -ErrorAction SilentlyContinue; if ($command) { $command.Source } else { $package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if ($package) { Join-Path $package.InstallLocation 'app\\resources\\codex.exe' } }";
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      const timer = setTimeout(() => { child.kill(); reject(new Error('查找 Codex 超时。')); }, 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); const executable = output.trim().split(/\r?\n/)[0]; executable ? resolve(executable) : reject(new Error('未找到 Codex，请先安装 Codex 桌面应用或 CLI。')); });
    });
    await access(command);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['mcp', 'add', 'todo_workspace', '--env', 'ELECTRON_RUN_AS_NODE=1', '--env', 'WORKSPACE_MCP_DESCRIPTOR=' + descriptor, '--', executable, entry], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-2000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Codex 配置超时，请检查 CLI 是否可用。')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve('Codex 用户级 MCP 已配置。请重新启动 Codex 或在新聊天中加载工具，使用时保持工作空间应用运行。') : reject(new Error(error || 'Codex 配置失败。')); });
  });
}
