import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
await mkdir('.build/android-tests', { recursive: true });
await build({ entryPoints: ['apps/android/web/store.ts'], outfile: '.build/android-tests/store.mjs', bundle: true, platform: 'node', format: 'esm', alias: { '@workspace/todo-list': path.resolve('packages/todo-list/src/index.ts'), '@workspace/contracts': path.resolve('packages/contracts/src/index.ts') } });
const { MobileStore } = await import('../.build/android-tests/store.mjs');
function native() {
  let revision = 0, state = { format: 1, spaces: [], current: null };
  return { fail: false, load() { return JSON.stringify({ ok: true, revision, state }); }, commit(expected, body) {
    if (this.fail || expected !== revision) return JSON.stringify({ ok: false, message: 'not committed' });
    state = JSON.parse(body); return JSON.stringify({ ok: true, revision: ++revision });
  } };
}
test('durable reload and isolated spaces', () => {
  const bridge = native(), store = new MobileStore(bridge);
  store.createSpace('one'); const first = store.current.id; store.add('保留\n换行');
  store.createSpace('two'); assert.equal(store.current.rows.length, 0);
  store.select(first); assert.equal(new MobileStore(bridge).current.rows[0].payload.text, '保留\n换行');
});
test('failed commit preserves previous state and stale revision cannot overwrite', () => {
  const bridge = native(), store = new MobileStore(bridge); store.createSpace('one');
  const stale = new MobileStore(bridge); bridge.fail = true;
  assert.throws(() => store.add('failed')); assert.equal(store.current.rows.length, 0);
  bridge.fail = false; store.add('saved');
  assert.throws(() => stale.add('stale')); assert.equal(new MobileStore(bridge).current.rows.length, 1);
});
test('shared tree rules prevent parent completion and require subtree deletion basis', () => {
  const store = new MobileStore(native()); store.createSpace('one'); store.add('parent');
  const parent = store.current.rows[0].recordId; store.add('child', parent);
  assert.throws(() => store.mutate(parent, { kind: 'complete', completed: true }));
  assert.throws(() => store.mutate(parent, { kind: 'delete', confirmed: true }));
  assert.equal(store.current.rows.filter(r => !r.deleted).length, 2);
});
