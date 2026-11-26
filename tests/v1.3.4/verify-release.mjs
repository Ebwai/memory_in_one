import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path, { resolve, join } from 'node:path';
import { _electron, chromium } from 'playwright-core';
import { build } from 'esbuild';
import { filterTodoTree, groupTodoTree } from '../../packages/todo-list/dist/index.js';

const require = createRequire(import.meta.url);
const artifacts = resolve('tests/v1.3.4/artifacts');
await mkdir(artifacts, { recursive: true });
const now = new Date().toISOString();
const today = now.slice(0, 10);
const rows = [
  { recordId: 'parent', payload: { text: '父目标', createdAt: now, completed: false } },
  { recordId: 'leaf', payload: { text: 'Release keyword', notes: '备注搜索', parentId: 'parent', createdAt: now, completed: true, completedAt: now, dueDate: today } },
  { recordId: 'other', payload: { text: '无关任务', createdAt: '2000-01-01T00:00:00Z', completed: false } },
].map(row => ({ ...row, workspaceId: 'qa', domainId: 'builtin.todo', deleted: false, localSequence: 1 }));
const tree = groupTodoTree(rows, today);
const nodes = [...tree.unfinished, ...tree.completed];
for (const field of ['createdAt', 'dueDate', 'completedAt']) {
  const result = filterTodoTree(nodes, 'completed', today, { start: today + 'T00:00', end: today + 'T23:59:59', field }, 'KEYWORD');
  assert.deepEqual(result.map(row => row.recordId), ['parent', 'leaf']);
}
assert.deepEqual(filterTodoTree(nodes, 'all', today, undefined, '备注搜索').map(row => row.recordId), ['parent', 'leaf']);
assert.deepEqual(filterTodoTree(nodes, 'all', today, undefined, 'missing'), []);
assert.deepEqual(filterTodoTree(nodes, 'all', today, { start: '2099-01-01T00:00', end: '2000-01-01T00:00' }), []);
console.log('PASS shared filter: all three timestamps, keyword and ancestor paths');

async function bounded(page, locator) {
  await locator.waitFor({ state: 'visible' });
  const box = await locator.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, JSON.stringify({ box, viewport }));
}

const windowsRoot = resolve('.build/release/user_application/windows/user_windows_v1.3.4/workspace-windows-v1.3.4');
const env = { ...process.env, WORKSPACE_CLIENT_DIRECTORY: join(artifacts, 'desktop-' + Date.now()), WORKSPACE_SETUP_HIDDEN: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: join(windowsRoot, '工作空间.exe'), env });
try {
  const page = await app.firstWindow();
  await page.getByRole('button', { name: '创建新工作空间', exact: true }).click();
  await page.getByRole('button', { name: '确认创建', exact: true }).click();
  await page.getByRole('button', { name: '返回主页', exact: false }).click();
  for (const text of ['父目标', 'Release keyword', '无关任务', '超长前置任务'.repeat(40)]) {
    await page.getByLabel('任务内容', { exact: true }).fill(text);
    await page.getByLabel('任务内容', { exact: true }).press('Enter');
    await page.getByRole('button', { name: text, exact: true }).waitFor();
  }
  await page.getByRole('button', { name: 'Release keyword', exact: true }).click();
  const detail = page.getByTestId('todo-details');
  await detail.locator('summary').filter({ hasText: '前置关联' }).click();
  await bounded(page, page.locator('.prerequisite-options'));
  await page.screenshot({ path: join(artifacts, 'windows-prerequisite.png') });
  await page.locator('.prerequisite-options').getByRole('button', { name: '关闭', exact: true }).click();
  await detail.getByRole('button', { name: '关闭详情', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '看板', exact: true }).count(), 0);
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  const panel = page.locator('fieldset').filter({ has: page.getByRole('textbox', { name: '关键字', exact: true }) });
  await panel.waitFor();
  const heading = await page.locator('.todo-review > .review-heading').boundingBox();
  const panelBox = await panel.boundingBox();
  assert.ok(panelBox.y >= heading.y + heading.height - 1);
  await panel.getByLabel('启用筛选', { exact: true }).check();
  await panel.getByLabel('按时间筛选', { exact: true }).uncheck();
  await panel.getByLabel('关键字', { exact: true }).fill('keyword');
  assert.equal(await page.getByTestId('captured-todo').count(), 1);
  await panel.locator('select').filter({ has: page.locator('option[value="createdAt"]') }).selectOption('createdAt');
  await panel.getByLabel('按时间筛选', { exact: true }).check();
  await panel.getByLabel('终点（留空为今天 24:00）', { exact: true }).fill('2000-01-01T00:00');
  assert.equal(await page.getByTestId('captured-todo').count(), 0);
  await panel.getByLabel('启用筛选', { exact: true }).uncheck();
  assert.equal(await page.getByTestId('captured-todo').count(), 4);
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await panel.waitFor({ state: 'detached' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(440, 740));
  await page.getByRole('button', { name: 'Release keyword', exact: true }).click();
  await detail.locator('summary').filter({ hasText: '前置关联' }).click();
  await bounded(page, page.locator('.prerequisite-options'));
  await page.screenshot({ path: join(artifacts, 'windows-small-window.png') });
  assert.equal(JSON.parse(await readFile(join(windowsRoot, 'workspace-release.json'), 'utf8')).version, '1.3.4');
  console.log('PASS packaged Windows: version, collapsible filter, real result changes and bounded prerequisite picker');
} finally { await app.close(); }

// Render the Android client with an isolated in-memory adapter. The UI and shared filtering are the shipped code.
const androidScript = await readFile('scripts/build-android.mjs', 'utf8');
const root = process.cwd();
const assets = artifacts;
const optionsText = androidScript.split('\n').find(line => line.startsWith('await build(')).trim().slice('await build('.length, -2);
const options = eval('(' + optionsText + ')');
const bundled = await build({ ...options, outfile: undefined, write: false, plugins: [{
  name: 'android-test-fixture',
  setup(builder) {
    builder.onLoad({ filter: /client-ui\.tsx$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8');
      const fixture = `
        const fixtureRows = ${JSON.stringify(rows)};
        fixtureRows.push({...fixtureRows[2],recordId:'long',payload:{...fixtureRows[2].payload,text:'超长前置任务'.repeat(40)}});
        const definition = { domainId: TODO_DOMAIN, name: '待办', view: {titleField:'text'}, schema:{properties:{text:{type:'string'},notes:{type:'string'},dueDate:{type:'string'}}} };
        const client = {
          current:{identity:{name:'Android QA'},replica:'qa'},message:'',loadCapture:()=>'',sync:async()=>{},conflicts:async()=>[],
          registry:{list:async()=>[{definition,enabled:true,programAvailable:true}]},rows:async()=>fixtureRows,
          store:{editor:async()=>null,saveEditor:async()=>{},clearEditor:async()=>{}},
          editTodo:async(id,sequence,value)=>{fixtureRows.find(row=>row.recordId===id).payload=value;}
        } as unknown as Client;
        window.AndroidPlatform={background:()=>{}} as typeof window.AndroidPlatform;
        createRoot(document.getElementById('root')!).render(<App client={client}/>);
      `;
      return { contents: source.slice(0, source.lastIndexOf('installNetwork();')) + fixture, loader: 'tsx' };
    });
  },
}] });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true });
  await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>');
  await page.addStyleTag({ content: await readFile('apps/android/web/app.css', 'utf8') });
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await page.getByLabel('启用筛选', { exact: true }).check();
  await page.getByLabel('按时间筛选', { exact: true }).uncheck();
  await page.getByLabel('关键字', { exact: true }).fill('keyword');
  assert.equal(await page.locator('.tasks article').count(), 2);
  await page.locator('select').filter({ has: page.locator('option[value="createdAt"]') }).selectOption('completedAt');
  await page.getByLabel('按时间筛选', { exact: true }).check();
  await page.getByLabel('终点（留空为今天 24:00）', { exact: true }).fill('2000-01-01T00:00');
  assert.equal(await page.locator('.tasks article').count(), 0);
  await page.getByLabel('启用筛选', { exact: true }).uncheck();
  await page.locator('button.task').filter({ hasText: 'Release keyword' }).click();
  await page.locator('.record-card summary').filter({ hasText: '前置关联' }).click();
  await bounded(page, page.locator('.prerequisite-options'));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(artifacts, 'android-prerequisite.png') });
  await page.locator('.prerequisite-options').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.screenshot({ path: join(artifacts, 'android-filter.png') });
  console.log('PASS Android UI at 360x640: keyword/ancestor filtering, time choice, close and viewport bounds');
} finally { await browser.close(); }
await writeFile(join(artifacts, 'verified.json'), JSON.stringify({ version: '1.3.4', verifiedAt: new Date().toISOString(), sharedFilter: true, packagedWindows: true, androidBrowserUI: true }, null, 2));
