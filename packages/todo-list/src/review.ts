import type { LocalRecord } from "@workspace/contracts";

export interface TodoDisplay {
  readonly recordId: string;
  readonly text: string;
  readonly status: "unfinished" | "completed" | "unknown";
  readonly dueDate: string | null;
  readonly dueState: "unset" | "valid" | "invalid";
  readonly dateLabel: string | null;
  readonly warning: string | null;
  readonly createdAt: string | null;
  readonly completedAt: string | null;
  readonly localSequence: number;
}

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
}

/** Caller supplies the device clock. Never derive a calendar day using UTC serialization. */
export function localCalendarDate(date: Date): string {
  return [String(date.getFullYear()).padStart(4, "0"), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

export function projectTodo(record: LocalRecord, today: string): TodoDisplay | null {
  if (record.deleted) return null;
  const payload = record.payload;
  const warnings: string[] = [];
  const text = typeof payload?.text === "string" ? payload.text : "任务内容无法识别";
  if (typeof payload?.text !== "string") warnings.push("任务内容无法识别");
  const status = payload?.completed === true ? "completed" : payload?.completed === false ? "unfinished" : "unknown";
  if (status === "unknown") warnings.push("完成状态无法识别，未将任务归为已完成");
  const rawDate = payload?.dueDate;
  const dueState = rawDate === undefined || rawDate === null ? "unset" : isCalendarDate(rawDate) ? "valid" : "invalid";
  const dueDate = dueState === "valid" ? rawDate as string : null;
  let dateLabel: string | null = null;
  if (dueState === "invalid") warnings.push("截止日期无法识别，无法判定时间状态");
  if (dueDate) {
    if (status === "completed") dateLabel = "截止 " + dueDate;
    else if (!isCalendarDate(today)) warnings.push("当前设备日期无法识别，无法判定时间状态");
    else dateLabel = dueDate === today ? "今天到期" : dueDate < today ? "已逾期 · " + dueDate : "截止 " + dueDate;
  }
  return { recordId: record.recordId, text, status, dueDate, dueState, dateLabel, warning: warnings.length ? warnings.join("；") : null,
    createdAt: typeof payload?.createdAt === "string" ? payload.createdAt : null,
    completedAt: typeof payload?.completedAt === "string" ? payload.completedAt : null,
    localSequence: record.localSequence };
}

export function groupTodos(records: readonly LocalRecord[], today: string): { unfinished: TodoDisplay[]; completed: TodoDisplay[] } {
  const all = records.map((record) => projectTodo(record, today)).filter((display): display is TodoDisplay => display !== null);
  const timestamp = (value: string | null) => { const parsed = value ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : -Infinity; };
  const sort = (field: "createdAt" | "completedAt") => (a: TodoDisplay, b: TodoDisplay) => {
    const left = timestamp(a[field]); const right = timestamp(b[field]);
    return left !== right ? left > right ? -1 : 1 : a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
  };
  return { unfinished: all.filter((item) => item.status !== "completed").sort(sort("createdAt")),
    completed: all.filter((item) => item.status === "completed").sort(sort("completedAt")) };
}
