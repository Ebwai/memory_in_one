import type { JsonObject } from "@workspace/contracts";
import { isCalendarDate } from "./review.js";

import { currentTodo, repeatPeriod } from "./repetition.js";
import type { RepeatFrequency } from "./repetition.js";
export type TodoCommand = { readonly kind: "notes"; readonly notes: string }
  | { readonly kind: "repeat"; readonly frequency: RepeatFrequency | null; readonly target: number; readonly timezone: string }
  | { readonly kind: "text"; readonly text: string } | { readonly kind: "date"; readonly dueDate: string | null }
  | { readonly kind: "complete"; readonly completed: boolean }
  | { readonly kind: "move"; readonly targetId: string | null; readonly position: "before" | "inside" | "after" }
  | { readonly kind: "delete"; readonly confirmed: true; readonly subtreeBasis?: string };
export function prepareTodoMutation(payload: JsonObject, raw: unknown, at: string): { kind: "put"; payload: JsonObject } | { kind: "delete" } {
  const command = raw as TodoCommand;
  if (!command || typeof command !== "object") throw new Error("无效的待办修改操作。");
  payload = currentTodo(payload, at);
  if (command.kind === "notes") {
    if (typeof command.notes !== "string") throw new Error("备注必须是文本。");
    return { kind: "put", payload: { ...payload, notes: command.notes } };
  }
  if (command.kind === "repeat") {
    const next = { ...payload };
    if (command.frequency === null) {
      for (const key of ["repeatFrequency", "repeatTarget", "repeatCount", "repeatPeriod", "repeatTimezone", "repeatLastAt"]) delete next[key];
    } else {
      if (!["day", "week", "month"].includes(command.frequency) || !Number.isSafeInteger(command.target) || command.target < 1 || command.target > 1000 || typeof command.timezone !== "string") throw new Error("请设置有效周期和 1–1000 的整数次数。");
      if (payload.repeatFrequency === command.frequency && payload.repeatTarget === command.target && payload.repeatTimezone === command.timezone) return { kind: "put", payload };
      Object.assign(next, { repeatFrequency: command.frequency, repeatTarget: command.target, repeatTimezone: command.timezone,
        repeatLastAt: at, repeatPeriod: repeatPeriod(at, command.frequency, command.timezone), repeatCount: 0, completed: false });
      delete next.completedAt;
    }
    return { kind: "put", payload: next };
  }
  if (command.kind === "text") {
    if (typeof command.text !== "string" || !command.text.trim()) throw new Error("请填写任务内容，不能保存纯空白。");
    return { kind: "put", payload: { ...payload, text: command.text } };
  }
  if (command.kind === "date") {
    if (command.dueDate !== null && !isCalendarDate(command.dueDate)) throw new Error("请输入有效的日历日期，或清除为未设置。");
    const next = { ...payload };
    if (command.dueDate === null) delete next.dueDate;
    else next.dueDate = command.dueDate;
    return { kind: "put", payload: next };
  }
  if (command.kind === "complete") {
    if (typeof command.completed !== "boolean" || !Number.isFinite(Date.parse(at))) throw new Error("完成状态或完成时间无效。");
    if (typeof payload.completed !== "boolean") throw new Error("当前完成状态无法识别，请先核对任务。");
    if (payload.repeatFrequency) {
      const count = command.completed ? Math.min(Number(payload.repeatTarget), Number(payload.repeatCount) + 1) : 0;
      const next: JsonObject = { ...payload, repeatLastAt: at, repeatCount: count, completed: count === payload.repeatTarget };
      if (next.completed) next.completedAt = payload.completedAt ?? at;
      else delete next.completedAt;
      return { kind: "put", payload: next };
    }
    if (payload.completed === command.completed) return { kind: "put", payload: { ...payload } };
    const next: JsonObject = { ...payload, completed: command.completed };
    if (command.completed) next.completedAt = at;
    else delete next.completedAt;
    return { kind: "put", payload: next };
  }
  if (command.kind === "delete") {
    if (command.confirmed !== true) throw new Error("请先明确确认删除此任务。");
    return { kind: "delete" };
  }
  throw new Error("不支持的待办修改操作。");
}
