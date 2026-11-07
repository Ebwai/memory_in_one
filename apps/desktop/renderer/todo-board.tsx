import { useState } from "react";
import type { LocalRecord } from "@workspace/contracts";
import { projectTodo } from "@workspace/todo-list";

function localDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}

export function TodoBoard({ records, today }: { records: readonly LocalRecord[]; today: string }) {
  const [start, setStart] = useState(() => { const date = new Date(today+"T12:00:00"); date.setDate(date.getDate()-6); return localDay(date); });
  const [end, setEnd] = useState(today);
  const valid = !!start && !!end && start <= end;
  const live = new Map(records.filter(r => !r.deleted && r.payload).map(r => [r.recordId,r]));
  const matches = new Set<string>();
  const included = new Set<string>();
  for (const record of live.values()) {
    const done = record.payload?.completedAt;
    if (!valid || record.payload?.completed !== true || typeof done !== "string" || !Number.isFinite(Date.parse(done))) continue;
    const day = localDay(new Date(done));
    if (day < start || day > end) continue;
    matches.add(record.recordId);
    let cursor: LocalRecord | undefined = record;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor.recordId)) {
      visited.add(cursor.recordId); included.add(cursor.recordId);
      cursor = live.get(String(cursor.payload?.parentId ?? ""));
    }
  }
  const children = new Map<string, LocalRecord[]>();
  for (const id of included) {
    const record = live.get(id)!;
    const parent = String(record.payload?.parentId ?? "");
    const key = included.has(parent) ? parent : "";
    children.set(key,[...(children.get(key) ?? []),record]);
  }
  const rows: { record: LocalRecord; depth: number }[] = [];
  const visited = new Set<string>();
  function walk(parent: string, depth: number) {
    const siblings = children.get(parent) ?? [];
    siblings.sort((a,b) => (typeof a.payload?.order === "number" ? a.payload.order : Number.MAX_SAFE_INTEGER) - (typeof b.payload?.order === "number" ? b.payload.order : Number.MAX_SAFE_INTEGER) || String(b.payload?.createdAt ?? "").localeCompare(String(a.payload?.createdAt ?? "")) || a.recordId.localeCompare(b.recordId));
    for (const record of siblings) {
      if (visited.has(record.recordId)) continue;
      visited.add(record.recordId); rows.push({record,depth}); walk(record.recordId,depth+1);
    }
  }
  walk("",0);
  return <section className="completion-board" aria-label="完成看板" data-testid="completion-board">
    <h2>完成看板</h2><p>按完成日期回看成果，保留父级目标。</p>
    <div className="board-dates"><label>开始日期<input type="date" aria-label="开始日期" value={start} onChange={e => setStart(e.target.value)}/></label><span>至</span><label>结束日期<input type="date" aria-label="结束日期" value={end} onChange={e => setEnd(e.target.value)}/></label></div>
    {!valid ? <p role="alert">请选择有效日期，开始日期不能晚于结束日期。</p> : <>
      <p data-testid="board-count">期间完成 {matches.size} 项</p>
      {!rows.length && <p>这个日期范围内没有已完成事项。</p>}
      <ul className="board-tree">{rows.map(({record,depth}) => {
        const display = projectTodo(record,today)!;
        const matched = matches.has(record.recordId);
        return <li key={record.recordId} data-context={!matched} style={{marginLeft:Math.min(depth,8)*16}}><span aria-hidden="true">{matched ? "☑" : "□"}</span><div><div className="board-text">{display.text}</div><small>{matched ? "完成于 "+localDay(new Date(display.completedAt!)) : "上下文 · "+(display.status === "completed" ? "范围外完成" : "未完成")}</small></div></li>;
      })}</ul>
    </>}
  </section>;
}
