import type { ConflictPolicy, ContentValue } from "@workspace/contracts";
import { isCalendarDate } from "./review.js";

import { validateRepetition } from "./repetition.js";
export function validateTodoConflict(value: ContentValue, base: ContentValue): void {
  if (value === null) return;
  validateRepetition(value);
  if (typeof value.text !== "string" || !value.text.trim() || typeof value.completed !== "boolean" ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
      (base !== null && value.createdAt !== base.createdAt) ||
      (value.dueDate !== undefined && !isCalendarDate(value.dueDate)) ||
      (value.completed ? typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt)) : value.completedAt !== undefined) ||
      Object.keys(value).some((key) => !["text", "createdAt", "dueDate", "completed", "completedAt", "parentId", "order", "notes", "repeatFrequency", "repeatTarget", "repeatCount", "repeatPeriod", "repeatTimezone", "repeatLastAt"].includes(key))) {
    throw new Error("待办选择无效：内容须非空，日期及完成时间须有效，创建时间不能改写。");
  }
}

export const todoConflictPolicy: ConflictPolicy = {
  attributes: { text: ["text"], dueDate: ["dueDate"], notes: ["notes"], completion: ["completed", "completedAt", "repeatFrequency", "repeatTarget", "repeatCount", "repeatPeriod", "repeatTimezone", "repeatLastAt"], placement: ["parentId", "order"] },
  validate: validateTodoConflict,
  // Both concurrent completions use the time already accepted by authority.
  compatible: (attribute, local, remote) => attribute === "completion" && !local.repeatFrequency && !remote.repeatFrequency && local.completed === remote.completed,
};
