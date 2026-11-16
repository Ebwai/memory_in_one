import type { ContentValue, JsonObject, LocalRecord } from "@workspace/contracts";
import { canonical } from "@workspace/contracts";
import { prepareTodoMutation } from "./progression.js";
import type { TodoCommand } from "./progression.js";
import { currentTodoRows } from "./repetition.js";
import { projectTodo } from "./review.js";
import type { TodoDisplay } from "./review.js";

export interface TodoNode extends TodoDisplay { parentId: string | null; depth: number; childCount: number; descendantCount: number; canComplete: boolean }
export interface TodoValue { recordId: string; value: ContentValue }

export function validateTodoTree(rows: readonly TodoValue[], previous?: readonly TodoValue[]): void {
  const values = new Map(rows.filter(r => r.value !== null).map(r => [r.recordId, r.value!]));
  if (previous) {
    const before = new Map(previous.map(row => [row.recordId, row.value]));
    for (const [id, value] of values) {
      if (typeof value.prerequisiteId !== "string") continue;
      const original = before.get(id);
      const required = values.get(value.prerequisiteId);
      if (original?.prerequisiteId !== value.prerequisiteId && !required) throw new Error("前置任务已不存在。");
      const advanced = value.completed === true && original?.completed !== true ||
        Number(value.repeatCount ?? 0) > Number(original?.repeatCount ?? 0);
      if (advanced && required?.completed !== true) throw new Error("请先完成前置任务。");
    }
  }
  const checked = new Set<string>();
  const visiting = new Set<string>();
  const dependencies = new Map<string, string[]>();
  for (const [id, value] of values) {
    const required = dependencies.get(id) ?? [];
    if (typeof value.prerequisiteId === "string" && values.has(value.prerequisiteId)) required.push(value.prerequisiteId);
    dependencies.set(id, required);
    if (typeof value.parentId === "string") {
      const children = dependencies.get(value.parentId) ?? [];
      children.push(id);
      dependencies.set(value.parentId, children);
    }
  }
  function visit(id: string): void {
    if (checked.has(id)) return;
    if (visiting.has(id)) throw new Error("父子关系或前置关联会形成循环。");
    visiting.add(id);
    for (const required of dependencies.get(id) ?? []) visit(required);
    visiting.delete(id);
    checked.add(id);
  }
  for (const id of values.keys()) visit(id);
  const done = new Set<string>();
  for (const [id, value] of values) {
    if (value.parentId !== undefined && (typeof value.parentId !== "string" || !value.parentId)) throw new Error("父事项身份无效。");
    if (value.order !== undefined && (typeof value.order !== "number" || !Number.isSafeInteger(value.order))) throw new Error("待办顺序无效。");
    const path = new Set<string>();
    let cursor: string | undefined = id;
    while (cursor && !done.has(cursor)) {
      if (path.has(cursor)) throw new Error("不能将事项移入自身或自己的后代。");
      path.add(cursor);
      const current = values.get(cursor);
      if (!current) throw new Error("父事项已不存在，请重新读取列表。");
      const parent = current.parentId as string | undefined;
      if (parent) {
        const ancestor = values.get(parent);
        if (!ancestor) throw new Error("父事项已不存在，不能留下孤立子待办。");
        if (ancestor.completed === true && current.completed !== true) throw new Error("所有子待办完成后，父待办才能完成。");
      }
      cursor = parent;
    }
    for (const visited of path) done.add(visited);
  }
}

export function todoSubtree(rows: readonly LocalRecord[], id: string): LocalRecord[] {
  const children = new Map<string, LocalRecord[]>();
  const live = rows.filter(r => !r.deleted && r.payload);
  for (const row of live) {
    const parent = row.payload!.parentId;
    if (typeof parent === "string") children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  const root = live.find(r => r.recordId === id);
  const result: LocalRecord[] = [], stack = root ? [root] : [], visited = new Set<string>();
  while (stack.length) {
    const row = stack.pop()!;
    if (visited.has(row.recordId)) continue;
    visited.add(row.recordId); result.push(row);
    stack.push(...(children.get(row.recordId) ?? []));
  }
  return result;
}

export function todoSubtreeBasis(rows: readonly LocalRecord[], id: string): string {
  return canonical(todoSubtree(rows, id).map(r => [r.recordId, r.localSequence]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))));
}

export function prepareTodoTree(rows: readonly LocalRecord[], id: string, command: TodoCommand, at: string): TodoValue[] {
  if (!command || typeof command!=="object" || (command.kind==="move" && (!["before","inside","after"].includes(command.position) || (command.targetId!==null && typeof command.targetId!=="string")))) throw new Error("无效的拖动操作。");
  const originalRows = rows;
  rows = currentTodoRows(rows, at);
  const source = rows.find(r => r.recordId === id && !r.deleted);
  if (!source?.payload) throw new Error("这条任务已不存在。");
  const values = new Map(rows.map(r => [r.recordId, r.deleted ? null : r.payload]));
  validateTodoTree([...values].map(([recordId,value]) => ({recordId,value})));
  const descendants = todoSubtree(rows,id);
  if (command.kind === "move") {
    const target = command.targetId === null ? null : rows.find(r => r.recordId === command.targetId && !r.deleted);
    if (command.targetId !== null && !target?.payload) throw new Error("拖动目标已不存在，请重新读取。");
    if (target && descendants.some(r => r.recordId === target.recordId)) throw new Error("不能将事项移入自身或自己的后代。");
    const parentId = !target ? undefined : command.position === "inside" ? target.recordId : target.payload!.parentId;
    const payload = { ...source.payload };
    if (typeof parentId === "string") payload.parentId = parentId; else delete payload.parentId;
    values.set(id,payload);
    const siblings = rows.filter(r => !r.deleted && r.recordId !== id && (r.payload?.parentId ?? null) === (parentId ?? null))
      .sort((a,b) => compareTodoOrder(a,b,"createdAt"));
    let index = target && command.position !== "inside" ? siblings.findIndex(r => r.recordId === target.recordId) : siblings.length;
    if (index < 0) throw new Error("拖动位置已变化，请重新读取。");
    if (target && command.position === "after") ++index;
    siblings.splice(index,0,source);
    siblings.forEach((r,order) => values.set(r.recordId,{ ...values.get(r.recordId)!, order }));
  } else if (command.kind === "delete") {
    if (descendants.length > 1 && command.subtreeBasis !== todoSubtreeBasis(rows,id)) throw new Error("子待办范围或内容已变化，请重新确认整棵树的删除。");
    if (command.confirmed !== true) throw new Error("请先明确确认删除。");
    for (const row of descendants) values.set(row.recordId,null);
  } else {
    if (command.kind === "complete" && command.completed && descendants.some(r => r.recordId !== id && r.payload?.completed !== true)) throw new Error("还有子待办未完成，请先完成所有子待办。");
    if (command.kind === "prerequisite" && command.recordId !== null && !values.get(command.recordId)) throw new Error("前置任务已不存在。");
    const prerequisite = source.payload.prerequisiteId;
    if (command.kind === "complete" && command.completed && typeof prerequisite === "string" && values.get(prerequisite)?.completed !== true) {
      throw new Error("请先完成前置任务；如果任务已删除，请重新设置前置关联。");
    }
    const mutation = prepareTodoMutation(source.payload,command,at);
    values.set(id,mutation.kind === "delete" ? null : mutation.payload);
  }
  // Restore ancestors in the same commit, from each incomplete node upwards.
  for (const [recordId,value] of values) {
    if (!value || value.completed === true) continue;
    let parent = value.parentId as string | undefined;
    const seen = new Set([recordId]);
    while (parent) {
      if (seen.has(parent)) throw new Error("不能将事项移入自己的后代。");
      seen.add(parent);
      const ancestor = values.get(parent);
      if (!ancestor) throw new Error("父事项已不存在。");
      if (ancestor.completed === true) { const restored: JsonObject = { ...ancestor,completed:false }; delete restored.completedAt; if (restored.repeatFrequency) restored.repeatCount = 0; values.set(parent,restored); }
      parent = ancestor.parentId as string | undefined;
    }
  }
  validateTodoTree([...values].map(([recordId,value]) => ({recordId,value})));
  return [id,...rows.map(r=>r.recordId).filter(key=>key!==id)]
    .filter(key=>key===id || canonical(values.get(key))!==canonical(originalRows.find(r=>r.recordId===key)?.deleted ? null : originalRows.find(r=>r.recordId===key)?.payload))
    .map(recordId=>({recordId,value:values.get(recordId) ?? null}));
}

function compareTodoOrder(a: LocalRecord,b: LocalRecord,field: string): number {
  const orderA = typeof a.payload?.order === "number" ? a.payload.order : -1;
  const orderB = typeof b.payload?.order === "number" ? b.payload.order : -1;
  if (orderA !== orderB) return orderA-orderB;
  const stamp = (r: LocalRecord) => {const n=Date.parse(String(r.payload?.[field] ?? "")); return Number.isFinite(n)?n:-Infinity;};
  const left=stamp(a),right=stamp(b);
  return left!==right ? left>right?-1:1 : a.recordId.localeCompare(b.recordId);
}

export function groupTodoTree(rows: readonly LocalRecord[],today:string): { unfinished:TodoNode[]; completed:TodoNode[]; completedRoots:number } {
  rows = currentTodoRows(rows, new Date().toISOString());
  const live=rows.filter(r=>!r.deleted && r.payload);
  const lookup=new Map(live.map(r=>[r.recordId,r]));
  const children=new Map<string|null,LocalRecord[]>();
  for(const row of live) {
    const raw=row.payload!.parentId;
    const parent=typeof raw==="string" && lookup.has(raw) ? raw:null;
    children.set(parent,[...(children.get(parent)??[]),row]);
  }
  for(const siblings of children.values()) siblings.sort((a,b)=>compareTodoOrder(a,b,"createdAt"));
  const result:{unfinished:TodoNode[];completed:TodoNode[];completedRoots:number}={unfinished:[],completed:[],completedRoots:0};
  const visited=new Set<string>();
  const roots=children.get(null)??[];
  const render=(root:LocalRecord) => {
    const completed=root.payload?.completed===true;
    if(completed) ++result.completedRoots;
    const stack=[{row:root,depth:0}];
    while(stack.length) {
      const {row,depth}=stack.pop()!;
      if(visited.has(row.recordId))continue;
      visited.add(row.recordId);
      const display=projectTodo(row,today); if(!display)continue;
      const descendants=todoSubtree(live,row.recordId);
      (completed?result.completed:result.unfinished).push({...display,depth,parentId:depth ? String(row.payload!.parentId):null,childCount:(children.get(row.recordId)??[]).length,descendantCount:descendants.length-1,canComplete:descendants.every(r=>r.recordId===row.recordId||r.payload?.completed===true)});
      stack.push(...[...(children.get(row.recordId)??[])].reverse().map(child=>({row:child,depth:depth+1})));
    }
  };
  roots.filter(r=>r.payload?.completed!==true).forEach(render);
  roots.filter(r=>r.payload?.completed===true).sort((a,b)=>compareTodoOrder(a,b,"completedAt")).forEach(render);
  // Damaged legacy links remain visible for diagnosis instead of silently hiding content.
  live.filter(r=>!visited.has(r.recordId)).forEach(render);
  return result;
}
