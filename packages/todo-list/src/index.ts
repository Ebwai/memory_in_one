export { todoConflictPolicy, validateTodoConflict } from "./conflicts.js";
import type { ExtensionDefinition, JsonObject } from "@workspace/contracts";
export { groupTodos, isCalendarDate, localCalendarDate, projectTodo } from "./review.js";
export type { TodoDisplay } from "./review.js";
export { prepareTodoMutation } from "./progression.js";
export { groupTodoTree, prepareTodoTree, todoSubtree, todoSubtreeBasis, validateTodoTree } from "./tree.js";
export type { TodoNode, TodoValue } from "./tree.js";
export type { TodoCommand } from "./progression.js";
export const TODO_DOMAIN = "builtin.todo";
export const todoDefinition: ExtensionDefinition = {
  format: 1, domainId: TODO_DOMAIN, name: "待办", version: "1.0.0", hostApi: 1, dataVersion: 1, access: "own-domain",
  schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
    properties: { text: { type: "string" }, createdAt: { type: "string" }, completed: { type: "boolean" } }, required: ["text", "createdAt", "completed"] },
  view: { titleField: "text", fields: ["text"] }, actions: ["create"],
};
export function prepareTodo(text: unknown, createdAt: string): JsonObject {
  if (typeof text !== "string" || !text.trim()) throw new Error("请填写任务内容，纯空白不能创建待办。");
  // A paste is one task. Preserve text verbatim; never infer dates or completion markers.
  return { text, createdAt, completed: false };
}
