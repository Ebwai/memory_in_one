import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const directory = resolve('tests/v1.3.4/artifacts');
await mkdir(directory, { recursive: true });
const packages = [
  '.build/release/user_application/windows/user_windows_v1.3.4/workspace-windows-v1.3.4-x64.zip',
  '.build/release/user_application/android/user_android_v1.3.4/workspace-android-v1.3.4.apk',
  '.build/release/server_application/ubuntu/server_ubuntu_v1.3.4/workspace-server-ubuntu-v1.3.4.tar.gz',
];
const hashes = {};
for (const file of packages) {
  const expected = (await readFile(file + '.sha256', 'utf8')).trim().split(/\s+/)[0];
  const actual = createHash('sha256').update(await readFile(file)).digest('hex');
  assert.equal(actual, expected);
  hashes[file] = actual;
}
const root = resolve('.build/release/server_application/ubuntu/server_ubuntu_v1.3.4/workspace-server-v1.3.4');
assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, '1.3.4');
const token = randomUUID() + randomUUID();
const child = spawn(process.execPath, [join(root, 'apps/server/dist/composition/main.js')], {
  cwd: root, windowsHide: true,
  env: { ...process.env, WORKSPACE_DATA_DIRECTORY: join(directory, 'server-' + Date.now()), WORKSPACE_BOOTSTRAP_TOKEN: token, WORKSPACE_PORT: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let diagnostics = '';
child.stderr.on('data', chunk => { diagnostics += chunk; });
try {
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Packaged server timeout ' + diagnostics)), 15000);
    child.once('error', reject);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(diagnostics)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0]).url); }
    });
  });
  async function post(path, body) {
    const response = await fetch(new URL(path, url), { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  }
  const initialized = await post('v1/initialize', { creationId: randomUUID(), name: 'v1.3.4 package QA' });
  assert.equal(initialized.status, 'created');
  const device = { id: randomUUID(), name: 'v1.3.4 verification' };
  const identity = initialized.workspace;
  await post('v1/sync/pull', { ...identity, cursor: 0, atomicProtocol: 1, device });
  const [connection] = await post('v1/sync/topology', identity);
  assert.equal(connection.id, device.id);
  assert.equal(connection.online, true);
  await writeFile(join(directory, 'packages-verified.json'), JSON.stringify({ version: '1.3.4', verifiedAt: new Date().toISOString(), hashes, serverStartup: true, serverSyncAndTopology: true }, null, 2));
  console.log('PASS all package SHA-256 values and packaged server startup/sync/topology');
} finally {
  if (child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
  }
}
