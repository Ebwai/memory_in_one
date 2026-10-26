import { DatabaseSync } from "node:sqlite";
import { LocalContentService } from "@workspace/core";
import { SqliteLocalStore } from "@workspace/adapters";

const [, , databasePath, mode] = process.argv;
if (!databasePath) throw new Error("Expected database path");
if (mode === "saved") {
  const store = await SqliteLocalStore.open({ databasePath });
  const result = await new LocalContentService(store).save({
    workspaceId: "space", domainId: "independent-notes", recordId: "child-record",
    operationId: "child-op", kind: "put", payload: { body: "已经提交，随后进程被强制终止" },
  });
  if (result.status !== "saved-local") throw new Error("Child save failed");
  process.send?.("saved");
} else if (mode === "uncommitted") {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
  const operation = db.prepare(`INSERT INTO pending_operations
    (workspace_id, domain_id, record_id, operation_id, kind, payload_json)
    VALUES ('space', 'independent-notes', 'partial', 'partial-op', 'put', '{"body":"未提交"}')`).run();
  db.prepare(`INSERT INTO local_records (workspace_id, domain_id, record_id, deleted, payload_json, last_sequence)
    VALUES ('space', 'independent-notes', 'partial', 0, '{"body":"未提交"}', ?)`).run(operation.lastInsertRowid);
  process.send?.("transaction-open");
} else {
  throw new Error("Unknown child mode");
}
// The parent terminates this process without graceful close/checkpoint.
setInterval(() => {}, 1000);

