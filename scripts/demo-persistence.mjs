import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { SqliteLocalStore } from "@workspace/adapters";
import { LocalContentService } from "@workspace/core";

const databasePath = join(mkdtempSync(join(tmpdir(), "workspace-save-demo-")), "workspace.sqlite");
const scope = { workspaceId: "demo-space", domainId: "demo-notes", recordId: randomUUID() };
let store = await SqliteLocalStore.open({ databasePath });
try {
  const result = await new LocalContentService(store).save({
    ...scope, operationId: randomUUID(), kind: "put", payload: { text: "先留下这个想法，稍后继续思考。" },
  });
  assert.equal(result.status, "saved-local");
  console.log("本机保存成功；尚未连接服务器。");
  await store.close();
  store = await SqliteLocalStore.open({ databasePath });
  const record = await store.readRecord(scope);
  const pending = await store.listPending(scope);
  assert.equal(record?.payload?.text, "先留下这个想法，稍后继续思考。");
  assert.equal(pending.length, 1);
  console.log("关闭并重新打开后：", record.payload.text);
  console.log("待同步操作数：", pending.length);
  console.log("演示数据已保留：", databasePath);
} finally {
  await store.close();
}
