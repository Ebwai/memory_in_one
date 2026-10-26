import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron } from "playwright-core";

const require=createRequire(import.meta.url);
test("real floating window drag order, recursive nesting, collapse, completion, subtree delete and restart",{timeout:120000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),"workspace-tree-window-"));
  const env={...process.env,WORKSPACE_CLIENT_DIRECTORY:directory,WORKSPACE_SETUP_HIDDEN:"1"};delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const launch=()=>_electron.launch({executablePath:require("electron"),args:["apps/desktop/dist/host/workspace-main.js"],env});
  try {
    app=await launch();let page=await app.firstWindow();
    await page.getByRole("button",{name:"创建新工作空间",exact:true}).click();
    await page.getByRole("button",{name:"确认创建",exact:true}).click();
    const row=text=>page.getByTestId("captured-todo").filter({has:page.getByRole("button",{name:text,exact:true})});
    for(const text of ["目标","子目标","步骤","独立事项"]) {
      await page.getByLabel("任务内容",{exact:true}).fill(text);await page.getByLabel("任务内容",{exact:true}).press("Enter");
      await row(text).waitFor();
    }
    const ids={};for(const text of ["目标","子目标","步骤","独立事项"])ids[text]=await row(text).getAttribute("data-record-id");
    async function drag(source,target,part="inside") {
      const targetRow=row(target);await targetRow.scrollIntoViewIfNeeded();
      const box=await targetRow.boundingBox();
      // Dispatch native HTML drag events in Chromium; coordinates stay explicit
      // when Windows scrolls the small floating viewport during a drag.
      const transfer=await page.evaluateHandle(()=>new DataTransfer());
      await row(source).getByRole("button",{name:"拖动事项："+source,exact:true}).dispatchEvent("dragstart",{dataTransfer:transfer});
      const clientY=box.y+(part==="before"?2:part==="after"?box.height-2:box.height/2);
      await targetRow.dispatchEvent("dragover",{dataTransfer:transfer,clientY,clientX:box.x+100});
      await targetRow.dispatchEvent("drop",{dataTransfer:transfer,clientY,clientX:box.x+100});
      await transfer.dispose();
      await page.getByTestId("todo-progress-notice").getByText(/修改已保存在本机/).waitFor();
    }
    await drag("子目标","目标");
    await page.locator('[data-record-id="'+ids["子目标"]+'"][data-depth="1"]').waitFor();
    assert.equal(await row("目标").getByRole("checkbox").isDisabled(),true);
    await drag("步骤","子目标");
    await page.locator('[data-record-id="'+ids["步骤"]+'"][data-depth="2"]').waitFor();
    await row("目标").getByRole("button",{name:"折叠子待办：目标",exact:true}).click();
    assert.equal(await row("步骤").count(),0);
    await row("目标").getByRole("button",{name:"展开子待办：目标",exact:true}).click();
    await row("步骤").getByRole("checkbox").click();
    await row("步骤").getByRole("checkbox",{name:"已完成任务",exact:true}).waitFor();
    assert.equal(await page.getByTestId("unfinished-todos").locator('[data-record-id="'+ids["步骤"]+'"]').count(),1);
    await row("子目标").getByRole("checkbox").click();
    await row("目标").getByRole("checkbox").click();
    await page.getByRole("button",{name:"已完成（1）",exact:true}).click();
    assert.equal(await page.getByTestId("completed-todos").getByTestId("captured-todo").count(),3);
    await row("步骤").getByRole("checkbox").click();
    await page.getByTestId("todo-progress-notice").getByText(/2 个受影响的父事项恢复/).waitFor();
    assert.equal(await page.getByTestId("unfinished-todos").getByTestId("captured-todo").count(),4);
    await drag("目标","独立事项","before");
    const ordered=await page.getByTestId("unfinished-todos").getByTestId("captured-todo").evaluateAll(nodes=>nodes.map(n=>n.getAttribute("data-record-id")));
    assert.ok(ordered.indexOf(ids["目标"])<ordered.indexOf(ids["独立事项"]));
    await page.screenshot({path:".build/todo-tree.png",fullPage:true});
    await app.close();app=await launch();page=await app.firstWindow();
    await page.locator('[data-record-id="'+ids["步骤"]+'"][data-depth="2"]').waitFor();
    await row("目标").getByRole("button",{name:"目标",exact:true}).click();
    const details=page.getByTestId("todo-details");
    await details.getByRole("button",{name:"删除任务",exact:true}).click();
    await details.getByText(/全部 2 条子待办/).waitFor();
    await details.getByRole("button",{name:"取消删除",exact:true}).click();
    assert.equal(await page.getByTestId("captured-todo").count(),4);
    await details.getByRole("button",{name:"删除任务",exact:true}).click();
    await details.getByRole("button",{name:"确认删除任务",exact:true}).click();
    await details.waitFor({state:"detached"});
    assert.equal(await page.getByTestId("captured-todo").count(),1);
    await row("独立事项").waitFor();
  } finally {
    if(app)await app.close();
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(directory.split(/[/\\]/).at(-1)?.startsWith("workspace-tree-window-"));
    rmSync(directory,{recursive:true,force:true});
  }
});
