import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, LocalRecord } from "@workspace/contracts";
import { groupTodos, isCalendarDate, localCalendarDate, projectTodo } from "@workspace/todo-list";

function record(payload: JsonObject | null, deleted = false): LocalRecord {
  return { workspaceId: "space", domainId: "builtin.todo", recordId: "task", localSequence: 1, deleted, payload };
}

test("N16 no date, future, today, past and completed tasks follow the display matrix", () => {
  for (const [dueDate, completed, label] of [
    [undefined, false, null], ["2026-10-26", false, "截止 2026-10-26"],
    ["2026-10-25", false, "今天到期"], ["2026-10-24", false, "已逾期 · 2026-10-24"],
    ["2026-10-24", true, "截止 2026-10-24"], [undefined, true, null],
  ] as const) {
    const source = record({ text: "原任务", completed, ...(dueDate ? { dueDate } : {}) });
    const display = projectTodo(source, "2026-10-25");
    assert.equal(display?.dateLabel, label);
    assert.equal(display?.status, completed ? "completed" : "unfinished");
    assert.equal(display?.warning, null);
    assert.equal(display?.recordId, source.recordId);
  }
});

test("N16 calendar validation handles leap years and invalid information remains visible", () => {
  assert.equal(isCalendarDate("2000-02-29"), true);
  assert.equal(isCalendarDate("1900-02-29"), false);
  for (const dueDate of ["2026-02-29", "2026-13-01", "2026-10-25T00:00:00Z", "", "0000-01-01", 12]) {
    const display = projectTodo(record({ text: "保留原任务", completed: false, dueDate }), "2026-10-25");
    assert.equal(display?.dueState, "invalid");
    assert.match(display?.warning ?? "", /日期无法识别/);
    assert.equal(display?.text, "保留原任务");
  }
  assert.equal(projectTodo(record({ text: "未知状态", completed: "yes" }), "2026-10-25")?.status, "unknown");
  assert.equal(projectTodo(record(null), "2026-10-25")?.status, "unknown");
  assert.equal(projectTodo(record({ text: "删除内容" }, true), "2026-10-25"), null);
});

test("N16 changing device day only changes projection and preserves the original task", () => {
  const source = record({ text: "跨日任务", completed: false, dueDate: "2026-10-25" });
  const before = JSON.stringify(source);
  assert.equal(projectTodo(source, "2026-10-24")?.dateLabel, "截止 2026-10-25");
  assert.equal(projectTodo(source, "2026-10-25")?.dateLabel, "今天到期");
  assert.equal(projectTodo(source, "2026-10-26")?.dateLabel, "已逾期 · 2026-10-25");
  assert.equal(JSON.stringify(source), before);
  const local = new Date(2026, 9, 25, 23, 59, 59);
  assert.equal(localCalendarDate(local), "2026-10-25");
});

test("N18 sections sort by creation and completion time with stable ties, unaffected by date labels", () => {
  const task = (recordId: string, completed: boolean, createdAt: string, completedAt?: string): LocalRecord => ({
    ...record({ text: recordId, completed, createdAt, dueDate: "2026-10-25", ...(completedAt ? { completedAt } : {}) }), recordId,
  });
  const source = [
    task("old", false, "2026-10-24T23:00:00Z"),
    task("tie-b", false, "2026-10-25T00:00:00Z"),
    task("done-old", true, "2026-10-25T03:00:00Z", "2026-10-25T04:00:00Z"),
    task("tie-a", false, "2026-10-25T00:00:00Z"),
    task("done-new", true, "2026-10-24T01:00:00Z", "2026-10-25T05:00:00Z"),
  ];
  const before = JSON.stringify(source);
  const current = groupTodos(source, "2026-10-25");
  const tomorrow = groupTodos([...source].reverse(), "2026-10-26");
  assert.deepEqual(current.unfinished.map((item) => item.recordId), ["tie-a", "tie-b", "old"]);
  assert.deepEqual(current.completed.map((item) => item.recordId), ["done-new", "done-old"]);
  assert.deepEqual(tomorrow.unfinished.map((item) => item.recordId), current.unfinished.map((item) => item.recordId));
  assert.deepEqual(tomorrow.completed.map((item) => item.recordId), current.completed.map((item) => item.recordId));
  assert.equal(JSON.stringify(source), before);
});
