import type { TodoNode } from "./tree.js";

export type TodoFilterStatus = "all" | "unfinished" | "completed";

export function filterTodoTree(nodes: readonly TodoNode[], status: TodoFilterStatus, today: string,
  deadline?: { start: string; end: string; field?: "createdAt" | "dueDate" | "completedAt" }, keyword = ""): TodoNode[] {
  const byId = new Map(nodes.map(node => [node.recordId, node]));
  const included = new Set<string>();
  const start = deadline?.start ? Date.parse(deadline.start) : -Infinity;
  const end = deadline?.end ? Date.parse(deadline.end) + (/T\d{2}:\d{2}$/.test(deadline.end) ? 59999 : 0) : new Date(
    Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)) + 1,
  ).getTime() - 1;
  for (const node of nodes) {
    if (keyword.trim() && !(node.text + "\n" + node.notes).toLocaleLowerCase().includes(keyword.trim().toLocaleLowerCase())) continue;
    if (status !== "all" && node.status !== status) continue;
    if (deadline) {
      const field = deadline.field ?? "dueDate";
      const value = node[field];
      if (!value) continue;
      const due = Date.parse(field === "dueDate" ? value + "T23:59" : value);
      if (!(due >= start && due <= end)) continue;
    }
    let ancestor: TodoNode | undefined = node;
    while (ancestor && !included.has(ancestor.recordId)) {
      included.add(ancestor.recordId);
      ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
    }
  }
  return nodes.filter(node => included.has(node.recordId));
}
