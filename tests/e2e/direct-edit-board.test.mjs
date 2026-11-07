import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

test('direct editing persists, refresh stays quiet, board keeps ancestor paths', {timeout:120000}, async () => {
  const directory=mkdtempSync(join(tmpdir(),'direct-edit-board-'));
  const env={...process.env,WORKSPACE_CLIENT_DIRECTORY:directory,WORKSPACE_SETUP_HIDDEN:'1'};delete env.ELECTRON_RUN_AS_NODE;
  const launch=()=>_electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['apps/desktop/dist/host/workspace-main.js'],env});
  let app=await launch();
  try {
    let p=await app.firstWindow();
    await p.getByRole('button',{name:'创建新工作空间',exact:true}).click();await p.getByRole('button',{name:'确认创建',exact:true}).click();
    await p.getByRole('button',{name:'返回主页',exact:false}).click();
    const row=text=>p.getByTestId('captured-todo').filter({has:p.getByRole('button',{name:text,exact:true})});
    for(const text of ['父目标','中间目标','完成的步骤','无关兄弟']) { await p.getByLabel('任务内容',{exact:true}).fill(text);await p.getByLabel('任务内容',{exact:true}).press('Enter');await row(text).waitFor(); }
    const ids={};for(const text of ['父目标','中间目标','完成的步骤','无关兄弟']) ids[text]=await row(text).getAttribute('data-record-id');
    // Use the real host mutation path to build the hierarchy.
    for(const [source,target] of [['中间目标','父目标'],['完成的步骤','中间目标'],['无关兄弟','父目标']]) {
      const result=await p.evaluate(async ({source,target})=>{const r=await window.workspaceSetup.domains({action:'read-domain',domainId:'builtin.todo'});const record=r.records.find(x=>x.recordId===source);return window.workspaceSetup.domains({action:'todo-progress',workspaceId:record.workspaceId,recordId:source,baseSequence:record.localSequence,operationId:crypto.randomUUID(),at:new Date().toISOString(),command:{kind:'move',targetId:target,position:'inside'}});},{source:ids[source],target:ids[target]});
      assert.equal(result.save?.status,'saved-local');
    }
    await p.evaluate(()=>window.dispatchEvent(new Event('workspace:replica-updated')));
    await row('完成的步骤').getByRole('button',{name:'完成的步骤',exact:true}).click();
    const detail=p.getByTestId('todo-details');
    assert.equal(await detail.getByRole('button',{name:/编辑/}).count(),0);
    await detail.getByTestId('todo-full-text').dblclick();
    const editor=detail.getByLabel('编辑任务内容',{exact:true});await editor.fill('取消内容');await editor.press('Escape');
    assert.equal(await detail.getByTestId('todo-full-text').innerText(),'完成的步骤');
    await detail.getByTestId('todo-full-text').dblclick();await editor.fill('已修改步骤');await editor.press('Tab');
    await detail.getByTestId('todo-full-text').getByText('已修改步骤',{exact:true}).waitFor();
    await detail.locator('.inspector-notes').dblclick();await detail.getByLabel('任务备注',{exact:true}).fill('周报备注');await detail.getByLabel('任务备注',{exact:true}).press('Tab');await detail.locator('.inspector-notes').getByText('周报备注').waitFor();
    await detail.locator('.inspector-field').filter({hasText:'截止日期'}).locator('.direct-edit').dblclick();await detail.getByLabel('截止日期选择',{exact:true}).fill('2026-11-20');await detail.getByLabel('截止日期选择',{exact:true}).press('Enter');await detail.locator('.direct-edit').getByText('2026-11-20',{exact:true}).waitFor();
    await detail.locator('.inspector-field').filter({hasText:'重复规则'}).locator('.direct-edit').dblclick();await detail.getByLabel('刷新周期').selectOption('week');await detail.getByLabel('每周期次数').fill('2');await detail.getByLabel('每周期次数').press('Tab');await detail.locator('.direct-edit').getByText('每周',{exact:true}).waitFor();
    // Cancel the repetition so this is a normal completed task for the report.
    await detail.locator('.inspector-field').filter({hasText:'重复规则'}).locator('.direct-edit').dblclick();await detail.getByLabel('刷新周期').selectOption('');await detail.locator('.inspector-status').click();await detail.locator('.direct-edit').getByText('不重复',{exact:true}).waitFor();
    await p.evaluate(()=>{window.__detailMutations=[];window.__detailObserver=new MutationObserver(ms=>{for(const m of ms)for(const node of m.addedNodes) window.__detailMutations.push(node.textContent);});window.__detailObserver.observe(document.querySelector('[data-testid=todo-details]'),{subtree:true,childList:true});for(let i=0;i<4;i++)window.dispatchEvent(new Event('workspace:replica-updated'));});
    await p.evaluate(()=>new Promise(resolve=>setTimeout(resolve,700)));
    assert.equal((await p.evaluate(()=>window.__detailMutations.join(' '))).includes('正在读取'),false);
    await detail.getByRole('button',{name:'标记完成',exact:true}).click();await detail.getByRole('button',{name:'恢复未完成',exact:true}).waitFor();await detail.getByRole('button',{name:'关闭详情',exact:true}).click();
    const binding=JSON.parse(readFileSync(join(directory,'binding.json'),'utf8'));
    const db=new DatabaseSync(binding.replicaPath);const before=db.prepare('SELECT count(*) n FROM pending_operations').get().n;db.close();
    await p.getByRole('button',{name:'看板',exact:true}).click();const board=p.getByTestId('completion-board');
    assert.equal(await board.locator('li').count(),3);assert.equal(await board.locator('[data-context=true]').count(),2);assert.equal(await board.getByText('无关兄弟',{exact:true}).count(),0);await board.getByText('期间完成 1 项').waitFor();
    const today=await board.getByLabel('结束日期').inputValue();await board.getByLabel('开始日期').fill(today);await board.getByText('期间完成 1 项').waitFor();
    await board.getByLabel('结束日期').fill('2000-01-01');await board.getByRole('alert').waitFor();await board.getByLabel('开始日期').fill('2000-01-01');await board.getByText('这个日期范围内没有已完成事项。').waitFor();
    const verify=new DatabaseSync(binding.replicaPath);assert.equal(verify.prepare('SELECT count(*) n FROM pending_operations').get().n,before);verify.close();
    await board.getByLabel('结束日期').fill(today);await board.getByLabel('开始日期').fill(today);await p.screenshot({path:'.build/completion-board.png'});
    await app.close();app=await launch();p=await app.firstWindow();await p.getByRole('button',{name:'返回主页',exact:false}).click();await row('已修改步骤').waitFor();
    await row('已修改步骤').getByRole('button',{name:'已修改步骤',exact:true}).click();await p.getByTestId('todo-details').locator('.inspector-notes').getByText('周报备注').waitFor();
  } catch(error) { const page=await app.firstWindow(); await page.screenshot({path:".build/direct-edit-failure.png"}); console.log((await page.getByTestId("todo-details").innerText().catch(()=>"no detail"))); throw error; } finally { await app.close(); }
});

test('project rows align and support direct editing without edit buttons', {timeout:90000}, async () => {
 const env={...process.env,WORKSPACE_CLIENT_DIRECTORY:mkdtempSync(join(tmpdir(),'project-edit-')),WORKSPACE_SETUP_HIDDEN:'1'};delete env.ELECTRON_RUN_AS_NODE;
 const app=await _electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['apps/desktop/dist/host/workspace-main.js'],env});
 try {
  const p=await app.firstWindow();await p.getByRole('button',{name:'创建新工作空间',exact:true}).click();await p.getByRole('button',{name:'确认创建',exact:true}).click();
  await p.getByRole('button',{name:'返回主页',exact:false}).click();await p.getByRole('button',{name:'工作空间',exact:true}).click();
  await p.getByText('＋ 新增插件',{exact:true}).click();await p.getByRole('button',{name:'按模板新建插件',exact:true}).click();await p.getByLabel('插件模板').selectOption('checklist');await p.getByLabel('项目名称',{exact:true}).fill('回归清单');await p.getByRole('button',{name:'创建项目插件',exact:true}).click();
  await p.locator('[data-testid^="domain-preset.checklist."]').getByRole('button',{name:'进入领域',exact:true}).click();
  const view=p.getByTestId('domain-view');
  for(const text of ['第一条很长的任务，检查换行以后右侧删除仍在正确位置。'.repeat(3),'第二条任务','第三条任务']) {await view.getByLabel('待办内容',{exact:true}).fill(text);await view.getByLabel('待办内容',{exact:true}).press('Enter');await view.locator('li').filter({hasText:text}).waitFor();}
  assert.equal(await view.getByRole('button',{name:'编辑',exact:true}).count(),0);
  const target=view.locator('.domain-record-content').filter({hasText:'第二条任务'});await target.dblclick();const field=view.getByLabel('修改内容',{exact:true});await field.fill('改好的第二条');await field.press('Enter');await view.getByLabel('修改内容',{exact:true}).waitFor({state:'detached'});await view.locator('.domain-record-content').getByText('改好的第二条',{exact:true}).waitFor();
  const positions=await view.locator('li').evaluateAll(rows=>rows.map(row=>{const content=row.querySelector('.domain-record-content').getBoundingClientRect();const checkbox=row.querySelector('input[type=checkbox]').getBoundingClientRect();const del=row.querySelector('button').getBoundingClientRect();return {content:content.x,checkbox:checkbox.x,delete:del.x,right:content.right};}));
  assert.equal(positions.length,3);assert.ok(positions.every(r=>r.checkbox<r.content && r.delete>=r.right));assert.ok(Math.max(...positions.map(r=>r.delete))-Math.min(...positions.map(r=>r.delete))<2);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(440,740));await p.screenshot({path:'.build/project-direct-edit.png'});
 } finally {await app.close();}
});
