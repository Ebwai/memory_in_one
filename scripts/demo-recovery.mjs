import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { SqliteLocalStore } from "@workspace/adapters";
import { LocalContentService } from "@workspace/core";

const databasePath = join(mkdtempSync(join(tmpdir(), "workspace-recovery-demo-")), "workspace.sqlite");
const scope = { workspaceId: "demo-space", domainId: "demo-notes", recordId: randomUUID() };
const original = { ...scope, operationId: randomUUID(), kind: "put", payload: { text: "最初留下的想法" } };
let store = await SqliteLocalStore.open({ databasePath });
try {
  let service = new LocalContentService(store);
  const [first, repeated] = await Promise.all([service.save(original), service.save(original)]);
  assert.equal(first.status, "saved-local");
  assert.deepEqual(first, repeated);
  assert.equal((await store.listPending(scope)).length, 1);
  console.log("同一次操作并发提交两次：只保存一份，返回同一结果。");

  const updated = await service.save({ ...original, operationId: randomUUID(), payload: { text: "基于最初想法继续推进的成果" } });
  assert.equal(updated.status, "saved-local");
  await store.close();
  store = await SqliteLocalStore.open({ databasePath });
  service = new LocalContentService(store);
  assert.deepEqual(await service.recover(original), first);
  assert.deepEqual(await service.save(original), first);
  const current = await store.readRecord(scope);
  assert.equal(current?.payload?.text, "基于最初想法继续推进的成果");
  assert.equal((await store.listPending(scope)).length, 2);
  console.log("重新打开后，已找回原提交结果；旧操作重试没有覆盖后续成果。");
  console.log("当前内容：", current.payload.text);
  console.log("演示数据已保留：", databasePath);
} finally {
  await store.close();
}
