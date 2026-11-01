import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron } from "playwright-core";
const require = createRequire(import.meta.url);
test("notes and six segmented completions persist through a real desktop restart", {timeout:120000}, async()=>{
  const directory=mkdtempSync(join(tmpdir(),"workspace-repeat-window-"));
  const env={...process.env,WORKSPACE_CLIENT_DIRECTORY:directory,WORKSPACE_SETUP_HIDDEN:"1"};
  delete env.ELECTRON_RUN_AS_NODE;
  const launch=()=>_electron.launch({executablePath:require("electron"),args:["apps/desktop/dist/host/workspace-main.js"],env});
  let app=await launch();
  try {
    let page=await app.firstWindow();
    await page.getByRole("button",{name:"创建新工作空间",exact:true}).click();
    await page.getByRole("button",{name:"确认创建",exact:true}).click();
    await page.getByLabel("任务内容",{exact:true}).fill("喝水六杯");
    await page.getByLabel("任务内容",{exact:true}).press("Enter");
    await page.getByRole("button",{name:"喝水六杯",exact:true}).click();
    const details=page.getByTestId("todo-details");
    await details.getByRole("button",{name:"编辑备注",exact:true}).click();
    await details.getByLabel("任务备注",{exact:true}).fill("每杯 200ml\n慢慢喝");
    await details.getByRole("button",{name:"保存修改",exact:true}).click();
    await details.getByText("每杯 200ml\n慢慢喝",{exact:true}).waitFor();
    await details.getByRole("button",{name:"设置重复",exact:true}).click();
    await details.getByLabel("刷新周期",{exact:true}).selectOption("day");
    await details.getByLabel("每周期次数",{exact:true}).fill("6");
    await details.getByRole("button",{name:"保存修改",exact:true}).click();
    await details.getByRole("button",{name:"完成一次",exact:true}).waitFor();
    await details.getByRole("button",{name:"关闭详情",exact:true}).click();
    for(let count=1;count<=6;count++) {
      const row=page.getByTestId("unfinished-todos").getByTestId("captured-todo");
      await row.getByRole("checkbox").click();
      const area=count===6?page.getByTestId("completed-todos"):page.getByTestId("unfinished-todos");
      await page.waitForFunction(({count})=>document.querySelector(`[role="progressbar"][aria-valuenow="${count}"]`)!==null,{count});
      assert.equal(await area.getByRole("progressbar",{includeHidden:true}).getAttribute("aria-valuenow"),String(count));
    }
    await app.close(); app=await launch(); page=await app.firstWindow();
    await page.getByRole("button",{name:"已完成（1）",exact:true}).click();
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"),"6");
    await page.getByRole("button",{name:"喝水六杯",exact:true}).click();
    await page.getByTestId("todo-details").getByText("每杯 200ml\n慢慢喝",{exact:true}).waitFor();
  } finally { await app.close(); }
});
