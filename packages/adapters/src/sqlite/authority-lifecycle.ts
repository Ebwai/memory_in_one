import type { DatabaseSync } from "node:sqlite";

/** The check belongs inside each write transaction, so stop cannot race a commit. */
export function authorityState(db: DatabaseSync): "active" | "stopped" | "prepared" {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='authority_lifecycle'").get()) return "active";
  const state = db.prepare("SELECT state FROM authority_lifecycle WHERE singleton=1").get()?.state;
  if (state !== "active" && state !== "stopped" && state !== "prepared") throw new Error("统一位置状态无法核对。");
  return state;
}

export function requireAuthorityWrite(db: DatabaseSync): void {
  if (authorityState(db) !== "active") throw new Error("此统一位置已停止写入或尚待迁移启用。");
}
