import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const LEASE_APPLICATION = 0x50574c31;
export function acquireServiceLease(directory: string): () => void {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, ".workspace-service-lock.sqlite"));
  try {
    const id = db.prepare("PRAGMA application_id").get()?.application_id;
    if (id === 0 && db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().length === 0) {
      db.exec(`PRAGMA application_id = ${LEASE_APPLICATION};`);
    } else if (id !== LEASE_APPLICATION) throw new Error("Unrecognized lease database");
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch { db.close(); throw new Error("该目录已有服务运行或无法安全锁定。"); }
  return () => { try { db.exec("ROLLBACK"); } finally { db.close(); } };
}

