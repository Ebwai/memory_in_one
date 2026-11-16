import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('server startup, home return and checklist template', async () => {
 const env={...process.env,WORKSPACE_CLIENT_DIRECTORY:mkdtempSync(join(tmpdir(),'checklist-ui-')),WORKSPACE_SETUP_HIDDEN:'1'};delete env.ELECTRON_RUN_AS_NODE;
 const app=await _electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['apps/desktop/dist/host/workspace-main.js'],env});
 try {const p=await app.firstWindow();
 await p.getByRole('button',{name:'创建新工作空间',exact:true}).click();await p.getByRole('button',{name:'确认创建',exact:true}).click();
 await p.getByRole('navigation',{name:'管理导航'}).waitFor();
 assert.equal(await p.locator('main').getAttribute('data-management-page'),'server');
 await p.getByRole('button',{name:'返回主页',exact:false}).click();await p.getByTestId('todo-capture').waitFor();
 await p.getByRole('button',{name:'工作空间',exact:true}).click();
 await p.getByText('＋ 新增插件',{exact:true}).click();await p.getByRole('button',{name:'按模板新建插件',exact:true}).click();
 await p.getByLabel('插件模板').selectOption('checklist');await p.getByLabel('项目名称',{exact:true}).fill('采购清单');await p.getByRole('button',{name:'创建项目插件',exact:true}).click();
 const card=p.locator('[data-testid^="domain-preset.checklist."]');await card.getByRole('button',{name:'进入领域',exact:true}).click();
 const view=p.getByTestId('domain-view');assert.equal(await view.getByRole('button',{name:'项目想法',exact:true}).count(),0);
 await view.getByLabel('待办内容',{exact:true}).fill('购买纸笔');await view.getByLabel('待办内容',{exact:true}).press('Enter');
 await view.getByRole('checkbox',{name:'完成',exact:true}).click();await view.getByRole('checkbox',{name:'恢复为未完成',exact:true}).waitFor();
 }finally{await app.close();}
});
