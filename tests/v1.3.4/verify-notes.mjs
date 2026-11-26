import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { _electron, chromium } from 'playwright-core';
import { build } from 'esbuild';
import { NOTES_DOMAIN, noteTitle, presetDefinition, matchesPreset, isCompatibleDomainUpgrade, validatePresetRecord } from '../../packages/contracts/dist/index.js';
import { DomainRegistry } from '../../packages/core/dist/index.js';
import { FileExtensionPrograms, SqliteLocalStore } from '../../packages/adapters/dist/index.js';

const artifacts = path.resolve('tests/v1.3.4/artifacts');
await mkdir(artifacts, { recursive: true });
const body = '这是一段没有填写标题的随记正文，用于验证十五字回退和隐藏内容。';
const fallback = Array.from(body).slice(0, 15).join('');
assert.equal(noteTitle({ text: body }), fallback);
assert.equal(noteTitle({ text: body, title: '  我的标题  ' }), '我的标题');
assert.equal(noteTitle({ text: '😀'.repeat(20), title: ' ' }), '😀'.repeat(15));
const legacy = presetDefinition(NOTES_DOMAIN, true);
const current = presetDefinition(NOTES_DOMAIN);
assert.ok(matchesPreset(legacy) && matchesPreset(current));
assert.ok(isCompatibleDomainUpgrade(legacy, current));
assert.throws(() => validatePresetRecord(NOTES_DOMAIN, { text: '  ', title: '标题', createdAt: new Date().toISOString() }));
const store = await SqliteLocalStore.open({ databasePath: path.join(artifacts, 'notes-upgrade-' + Date.now() + '.sqlite') });
try {
  const registry = new DomainRegistry('notes-qa', store, new FileExtensionPrograms(path.join(artifacts, 'notes-programs')));
  await registry.register(legacy, 'register-old');
  await registry.setEnabled(NOTES_DOMAIN, true, 'enable');
  await (await registry.contentStore(NOTES_DOMAIN)).commit({ workspaceId: 'notes-qa', domainId: NOTES_DOMAIN, recordId: 'old-note', operationId: 'old-note-create', kind: 'put', payloadJson: JSON.stringify({ text: body, createdAt: '2026-01-01T00:00:00Z' }) }, null);
  await registry.register(current, 'upgrade');
  const [oldNote] = await store.listRecords({ workspaceId: 'notes-qa', domainId: NOTES_DOMAIN });
  assert.equal(noteTitle(oldNote.payload), fallback);
  assert.equal(oldNote.payload.createdAt, '2026-01-01T00:00:00Z');
} finally { await store.close(); }
console.log('PASS notes model and optional-title schema upgrade without rewriting old content');

const env = { ...process.env, WORKSPACE_CLIENT_DIRECTORY: path.join(artifacts, 'notes-desktop-' + Date.now()), WORKSPACE_SETUP_HIDDEN: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: path.resolve('.build/release/user_application/windows/user_windows_v1.3.4/workspace-windows-v1.3.4/工作空间.exe'), env });
try {
  const page = await app.firstWindow();
  await page.getByRole('button', { name: '创建新工作空间', exact: true }).click();
  await page.getByRole('button', { name: '确认创建', exact: true }).click();
  await page.getByRole('button', { name: '返回主页', exact: false }).click();
  await page.getByRole('button', { name: '工作空间', exact: true }).click();
  await page.getByTestId('domain-preset.notes').getByRole('button', { name: '进入领域', exact: true }).click();
  const view = page.getByTestId('domain-view');
  await view.getByLabel('随记标题（选填）', { exact: true }).fill('只有标题');
  assert.ok(await view.getByRole('button', { name: '保存领域内容', exact: true }).isDisabled());
  await view.getByLabel('随记标题（选填）', { exact: true }).fill('');
  await view.getByLabel('随记内容', { exact: true }).fill(body);
  await view.getByRole('button', { name: '保存领域内容', exact: true }).click();
  const content = view.locator('.domain-record-content');
  await content.getByText(fallback, { exact: true }).waitFor();
  assert.equal(await content.getByText(body, { exact: true }).count(), 0);
  await content.getByText(fallback, { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '随记详情' });
  assert.equal(await dialog.getByLabel('随记正文', { exact: true }).inputValue(), body);
  await dialog.getByLabel('随记详情标题（选填）', { exact: true }).fill('自定义随记标题');
  await dialog.getByRole('button', { name: '保存并关闭', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await content.getByText('自定义随记标题', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'windows-notes-titles.png') });
  await content.getByText('自定义随记标题', { exact: true }).click();
  assert.equal(await dialog.getByLabel('随记正文', { exact: true }).inputValue(), body);
  await page.screenshot({ path: path.join(artifacts, 'windows-notes-detail.png') });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  console.log('PASS Windows notes: optional title, required body, title-only list and single-click body editor');
} finally { await app.close(); }

const androidScript = await readFile('scripts/build-android.mjs', 'utf8');
const root = process.cwd();
const assets = artifacts;
const options = eval('(' + androidScript.split('\n').find(line => line.startsWith('await build(')).trim().slice('await build('.length, -2) + ')');
const bundle = await build({ ...options, outfile: undefined, write: false, plugins: [{ name: 'notes-qa', setup(builder) {
  builder.onLoad({ filter: /client-ui\.tsx$/ }, async ({ path: file }) => {
    const source = await readFile(file, 'utf8');
    const fixture = `
      const rows = [{workspaceId:'qa',domainId:NOTES_DOMAIN,recordId:'old',deleted:false,localSequence:1,payload:{text:${JSON.stringify(body)},createdAt:new Date().toISOString()}}];
      const definitions = [${JSON.stringify(presetDefinition('preset.notes'))},${JSON.stringify({ ...presetDefinition('preset.notes'), domainId: 'builtin.todo', name: '待办' })}];
      const captures = new Map();
      const client = {current:{identity:{name:'Notes QA'},replica:'qa'},message:'',registry:{list:async()=>definitions.map(definition=>({definition,enabled:true,programAvailable:true}))},
        rows:async(domain)=>rows.filter(row=>row.domainId===domain),conflicts:async()=>[],sync:async()=>{},loadCapture:key=>captures.get(key)||'',saveCapture:(key,text)=>captures.set(key,text),
        store:{editor:async()=>null,saveEditor:async()=>{},clearEditor:async()=>{}},
        saveRecord:async(domain,id,value)=>{if(!value.text.trim())throw Error('正文必填');const row=rows.find(row=>row.recordId===id);if(row)row.payload=value;else rows.push({workspaceId:'qa',domainId:domain,recordId:id,localSequence:1,deleted:false,payload:value});}
      } as unknown as Client;
      window.AndroidPlatform={background:()=>{}} as typeof window.AndroidPlatform;
      createRoot(document.getElementById('root')!).render(<App client={client}/>);
    `;
    return { contents: source.slice(0, source.lastIndexOf('installNetwork();')) + fixture, loader: 'tsx' };
  });
} }] });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true });
  await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>');
  await page.evaluate(() => { if (!crypto.randomUUID) crypto.randomUUID = () => '00000000-0000-4000-8000-' + String(Date.now()).slice(-12); });
  await page.addStyleTag({ content: await readFile('apps/android/web/app.css', 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator('main > label select').selectOption(NOTES_DOMAIN);
  await page.locator('button.task').getByText(fallback, { exact: true }).waitFor();
  assert.equal(await page.locator('button.task').getByText(body, { exact: true }).count(), 0);
  await page.getByLabel('标题（选填）', { exact: true }).fill('新随记');
  assert.ok(await page.locator('form.capture button').isDisabled());
  await page.getByLabel('正文（必填）', { exact: true }).fill('这是新随记的完整正文');
  await page.locator('form.capture button').click();
  await page.locator('button.task').getByText('新随记', { exact: true }).waitFor();
  await page.locator('button.task').getByText(fallback, { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑详情' });
  await dialog.waitFor();
  assert.equal(await dialog.locator('textarea').inputValue(), body);
  await dialog.getByLabel('标题（选填）', { exact: true }).fill('手机版标题');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.locator('button.task').getByText('手机版标题', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'android-notes-titles.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  console.log('PASS Android notes: two fields, title-only list, legacy fallback and detail save');
} finally { await browser.close(); }
