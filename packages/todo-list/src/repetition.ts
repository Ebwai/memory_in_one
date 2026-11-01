import type { JsonObject, LocalRecord } from "@workspace/contracts";

export type RepeatFrequency = "day" | "week" | "month";
export function repeatPeriod(at: string, frequency: RepeatFrequency, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at));
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  if (frequency === "month") return date.slice(0, 7);
  if (frequency === "day") return date;
  const monday = new Date(date + "T00:00:00Z");
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return monday.toISOString().slice(0, 10);
}

export function validateRepetition(value: JsonObject): void {
  if (value.notes !== undefined && typeof value.notes !== "string") throw new Error("备注必须是文本。");
  const fields = ["repeatFrequency", "repeatTarget", "repeatCount", "repeatPeriod", "repeatTimezone", "repeatLastAt"];
  if (value.repeatFrequency === undefined) {
    if (fields.some(key => value[key] !== undefined)) throw new Error("重复设置不完整。");
    return;
  }
  if (!["day", "week", "month"].includes(String(value.repeatFrequency)) ||
      !Number.isSafeInteger(value.repeatTarget) || Number(value.repeatTarget) < 1 || Number(value.repeatTarget) > 1000 ||
      !Number.isSafeInteger(value.repeatCount) || Number(value.repeatCount) < 0 || Number(value.repeatCount) > Number(value.repeatTarget) ||
      typeof value.repeatTimezone !== "string" || typeof value.repeatPeriod !== "string" ||
      value.completed !== (value.repeatCount === value.repeatTarget)) throw new Error("重复设置或进度无效，目标次数须为 1–1000 的整数。");
  if (value.repeatLastAt !== undefined && (typeof value.repeatLastAt !== "string" || !Number.isFinite(Date.parse(value.repeatLastAt)))) throw new Error("重复操作时间无效。");
  repeatPeriod("2026-01-01T00:00:00Z", value.repeatFrequency as RepeatFrequency, value.repeatTimezone);
  const pattern = value.repeatFrequency === "month" ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/;
  if (!pattern.test(value.repeatPeriod)) throw new Error("重复周期无效。");
}

/** Period changes are a projection, not background writes that race offline edits. */
export function currentTodo(payload: JsonObject, at: string): JsonObject {
  if (!payload.repeatFrequency) return payload;
  validateRepetition(payload);
  const period = repeatPeriod(at, payload.repeatFrequency as RepeatFrequency, String(payload.repeatTimezone));
  if (period <= String(payload.repeatPeriod)) return payload;
  const next: JsonObject = { ...payload, completed: false, repeatCount: 0, repeatPeriod: period };
  delete next.completedAt;
  return next;
}

export function currentTodoRows(rows: readonly LocalRecord[], at: string): LocalRecord[] {
  const result = rows.map(row => ({ ...row, payload: row.payload ? currentTodo(row.payload, at) : null }));
  const lookup = new Map(result.map(row => [row.recordId, row]));
  for (const row of result) {
    if (row.deleted || !row.payload || row.payload.completed) continue;
    let parent = row.payload.parentId;
    const seen = new Set<string>();
    while (typeof parent === "string" && !seen.has(parent)) {
      seen.add(parent);
      const ancestor = lookup.get(parent);
      if (!ancestor?.payload) break;
      if (ancestor.payload.completed) {
        ancestor.payload = { ...ancestor.payload, completed: false };
        delete ancestor.payload.completedAt;
        if (ancestor.payload.repeatFrequency) ancestor.payload.repeatCount = 0;
      }
      parent = ancestor.payload.parentId;
    }
  }
  return result;
}
