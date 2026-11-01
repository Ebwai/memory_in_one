import { _electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const directory = mkdtempSync(join(tmpdir(), 'workspace-pixel-preview-'));
const env = { ...process.env, WORKSPACE_CLIENT_DIRECTORY: directory, WORKSPACE_SETUP_HIDDEN: '1' };
delete env.ELECTRON_RUN_AS_NODE;
mkdirSync('output/ui-preview', { recursive: true });
const application = await _electron.launch({ executablePath: require('electron'), args: ['apps/desktop/dist/host/workspace-main.js'], env });
try {
  const page = await application.firstWindow();
  await page.getByRole('button', { name: '创建新工作空间', exact: true }).click();
  await page.getByRole('button', { name: '确认创建', exact: true }).click();
  await page.getByTestId('todo-capture').waitFor();
  await page.getByRole('button', { name: '工作空间管理', exact: true }).click();
  for (const name of ['产品开发', '装修计划']) {
    await page.getByLabel('项目名称', { exact: true }).fill(name);
    await page.getByRole('button', { name: '创建项目插件', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[aria-label="项目名称"]')?.value === '');
  }
  await page.getByRole('navigation', { name: '插件目录' }).getByRole('button', { name: /待办/ }).click();
  for (const text of ['完成产品原型', '整理页面结构', '确认交互细节', '阅读 30 分钟']) {
    await page.getByLabel('任务内容', { exact: true }).fill(text);
    await page.getByTestId('todo-capture').getByRole('button', { name: '添加待办', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#todo-text')?.value === '');
  }
  await page.getByTestId('captured-todo').getByText('完成产品原型', { exact: true }).click();
  await page.getByTestId('todo-full-text').waitFor();
  await page.getByRole('button', { name: '编辑备注', exact: true }).click();
  await page.getByLabel('任务备注', { exact: true }).fill('完成核心页面的产品原型，重点关注用户路径和关键交互。与设计师同步确认页面结构，准备下一阶段评审。');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.getByTestId('todo-editor').waitFor({ state: 'detached' });
  await page.screenshot({ path: 'output/ui-preview/pixel-workbench.png' });
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.getByRole('button', { name: '悬浮窗口', exact: true }).click();
  await page.waitForFunction(() => document.body.classList.contains('floating'));
  await page.screenshot({ path: 'output/ui-preview/pixel-floating.png' });
  await page.getByRole('button', { name: '工作空间管理', exact: true }).click();
  await page.getByLabel('项目名称', { exact: true }).fill('产品开发');
  await page.getByRole('button', { name: '创建项目插件', exact: true }).click();
  await page.getByRole('navigation', { name: '插件目录' }).getByRole('button', { name: /产品开发/ }).click();
  await page.getByTestId('domain-view').waitFor();
  await page.getByLabel('想法内容', { exact: true }).fill('把想法变成清晰的产品。先整理核心流程，再完善页面细节。');
  await page.getByRole('button', { name: '保存领域内容', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="想法内容"]')?.value === '');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'output/ui-preview/pixel-project.png' });
  console.log('Preview screenshots saved to output/ui-preview.');
} finally { await application.close(); }
