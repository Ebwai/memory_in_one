import type { JsonObject } from "@workspace/contracts";
import { isCalendarDate } from "./review.js";

export type TodoCommand = { readonly kind: "text"; readonly text: string } | { readonly kind: "date"; readonly dueDate: string | null }
  | { readonly kind: "complete"; readonly completed: boolean }
  | { readonly kind: "move"; readonly targetId: string | null; readonly position: "before" | "inside" | "after" }
  | { readonly kind: "delete"; readonly confirmed: true; readonly subtreeBasis?: string };
export function prepareTodoMutation(payload: JsonObject, raw: unknown, at: string): { kind: "put"; payload: JsonObject } | { kind: "delete" } {
  const command = raw as TodoCommand;
  if (!command || typeof command !== "object") throw new Error("无效的待办修改操作。");
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
