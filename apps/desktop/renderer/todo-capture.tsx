import { ConflictPanel } from "./conflict-panel.js";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { LocalRecord } from "@workspace/contracts";
import { groupTodoTree, prepareTodo } from "@workspace/todo-list";
import type { TodoNode } from "@workspace/todo-list";
import type { DomainResponse } from "../bridge/workspace-contracts.js";
import { useTodoProgress } from "./use-todo-progress.js";
import { TodoDetails } from "./todo-details.js";
import { useLocalDay } from "./use-local-day.js";
import type { DomainViewHandle } from "./domain-view.js";

export const TodoCapture = forwardRef<DomainViewHandle, { onManagement(): void }>(function TodoCapture({ onManagement }, ref) {
  const [text, setText] = useState("");
  const [records, setRecords] = useState<readonly LocalRecord[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [pinned, setPinned] = useState(true);
  const today = useLocalDay();
  const [selected, setSelected] = useState<LocalRecord | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [listError, setListError] = useState("");
  const reading = useRef(false);
  const readGeneration = useRef(0);
  const origin = useRef<HTMLElement | null>(null);
  const details = useRef<DomainViewHandle>(null);
  const conflicts = useRef<DomainViewHandle>(null);
  const [conflictedIds, setConflictedIds] = useState<readonly string[]>([]);
  function acceptProgress(result: DomainResponse) {
    if (!result.ok) return;
    ++readGeneration.current;
    if (result.records) { setRecords(result.records); setLoadState("ready"); setListError(""); }
    else if (result.record !== undefined) {
      const updated = result.record;
      if (updated) setRecords((current) => [...current.filter((record) => record.recordId !== updated.recordId), updated]);
      else void load();
    } else if (result.save?.status === "saved-local") { setListError("保存已确认，最新列表暂无法读取，请重新读取。"); setLoadState("error"); }
  }
  const progress = useTodoProgress(acceptProgress);
  function closeDetails() { setSelected(null); window.requestAnimationFrame(() => { if (origin.current?.isConnected) origin.current.focus({ preventScroll: true }); else input.current?.focus({ preventScroll: true }); }); }
  const input = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const composing = useRef(false);
  const attempt = useRef<{ recordId: string; operationId: string; createdAt: string; text: string } | null>(null);
  async function load() {
    if (reading.current || submitting.current || dragOrigin.current) return;
    reading.current = true;
    const generation = ++readGeneration.current;
    setLoadState("loading");
    try {
      const result = await window.workspaceSetup.domains({ action: "read-domain", domainId: "builtin.todo" });
      if (generation !== readGeneration.current || dragOrigin.current) return;
      if (!result.ok) { setLoadState("error"); setListError("无法读取最新本机列表，保留已有内容。" + result.message); }
      else if (result.records) { setRecords(result.records); setLoadState("ready"); setListError(""); }
      else { setLoadState("error"); setListError("列表信息不完整，保留已有内容。"); }
    } catch { if (generation === readGeneration.current) { setLoadState("error"); setListError("暂时无法读取待办，保留已有内容；最新状态尚未确认。"); } }
    finally { reading.current = false; }
  }
  useEffect(() => { void load(); input.current?.focus(); const updated = () => void load(); window.addEventListener("workspace:replica-updated", updated); return () => window.removeEventListener("workspace:replica-updated", updated); }, []);
  async function discard() { if (submitting.current || uncertain || progress.hasPending() || (conflicts.current && !await conflicts.current.discard()) || (details.current && !await details.current.discard())) return false; setText(""); attempt.current = null; return true; }
  async function save(): Promise<boolean> {
    if (submitting.current) return false;
    if (!text.trim()) { setMessage("请填写任务内容，纯空白不能创建待办。"); input.current?.focus(); return false; }
    submitting.current = true; setBusy(true); setMessage("正在保存到本机…");
    attempt.current ??= { recordId: crypto.randomUUID(), operationId: crypto.randomUUID(), createdAt: new Date().toISOString(), text };
    const original = attempt.current;
    try {
      const result = await window.workspaceSetup.domains({ action: uncertain ? "todo-recover" : "todo-create", domainId: "builtin.todo", ...original });
      if (!result.ok) { setMessage(result.message); return false; }
      if (result.save?.status === "saved-local") {
        setText(""); attempt.current = null; setUncertain(false); setMessage("已保存在本机，待同步。");
        ++readGeneration.current;
        if (result.records) { setRecords(result.records); setLoadState("ready"); setListError(""); }
        else {
          if (result.workspaceId) setRecords((current) => [...current.filter((record) => record.recordId !== original.recordId), {
            workspaceId: result.workspaceId!,  domainId: "builtin.todo", recordId: original.recordId,
            localSequence: result.save!.status === "saved-local" ? result.save!.localSequence : 0,
            deleted: false, payload: prepareTodo(original.text, original.createdAt),
          }]);
          setLoadState("error"); setListError("任务已保存，列表最新信息暂无法读取，保留此前内容。");
        }
        return true;
      }
      setMessage(result.save?.message ?? "保存结果暂不能确认，请核对原操作。");
      setUncertain(result.save?.status !== "not-saved");
      return false;
    } catch { setUncertain(true); setMessage("保存结果暂不能确认，请保留文字并核对原操作。"); return false; }
    finally { submitting.current = false; setBusy(false); input.current?.focus(); }
  }
  useImperativeHandle(ref, () => ({
    get dirty() { return !!text || busy || uncertain || !!conflicts.current?.dirty || !!details.current?.dirty || progress.hasPending(); },
    save: async () => {
      if (conflicts.current?.dirty && !await conflicts.current.save()) return false;
      if (details.current?.dirty && !await details.current.save()) return false;
      if (!await progress.settle()) return false;
      return text ? save() : true;
    },
    discard,
  }));
  const groups = groupTodoTree(records, today);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [dragged, setDragged] = useState<string | null>(null);
  const dragOrigin = useRef<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string | null; position: "before" | "inside" | "after" } | null>(null);
  function finishDrag() { dragOrigin.current = null; setDragged(null); setDropHint(null); void load(); }
  function moveTo(targetId: string | null, position: "before" | "inside" | "after") {
    const id = dragOrigin.current;
    finishDrag();
    const record = records.find(r=>r.recordId===id);
    if (record && !progress.hasPending()) void progress.mutate(record,{kind:"move",targetId,position}).then(result=>{
      if(result.saved && targetId && position==="inside") setCollapsed(previous=>{const next=new Set(previous);next.delete(targetId);return next;});
    });
  }
  function visible(nodes: TodoNode[]): TodoNode[] {
    const hidden = new Set<string>();
    return nodes.filter(node=>{
      if(node.parentId && (hidden.has(node.parentId) || collapsed.has(node.parentId))) {hidden.add(node.recordId);return false;}
      return true;
    });
  }
  function row(display: TodoNode) {
    return <li key={display.recordId} data-testid="captured-todo" data-record-id={display.recordId} data-depth={display.depth}
      className={dropHint?.id===display.recordId ? "todo-drop-"+dropHint.position : ""}
      style={{marginLeft:display.depth*20, minWidth:220}}
      onDragOver={event=>{
        if(!dragOrigin.current || dragOrigin.current===display.recordId || progress.hasPending())return;
        event.preventDefault();event.stopPropagation();
        const rect=event.currentTarget.getBoundingClientRect(),fraction=(event.clientY-rect.top)/rect.height;
        setDropHint({id:display.recordId,position:fraction<0.25?"before":fraction>0.75?"after":"inside"});
        event.dataTransfer.dropEffect="move";
      }}
      onDrop={event=>{event.preventDefault();event.stopPropagation();if(!dragOrigin.current)return;const rect=event.currentTarget.getBoundingClientRect(),fraction=(event.clientY-rect.top)/rect.height;moveTo(display.recordId,fraction<0.25?"before":fraction>0.75?"after":"inside");}}>
      <button className="todo-drag-handle" aria-label={"拖动事项："+display.text} title="拖到事项之间排序，拖到中央成为子待办"
        draggable={!progress.hasPending() && !conflictedIds.includes(display.recordId) && !records.find(r=>r.recordId===display.recordId)?.pendingConfirmation}
        onDragStart={event=>{if(progress.hasPending()){event.preventDefault();return;}dragOrigin.current=display.recordId;setDragged(display.recordId);event.dataTransfer.setData("text/plain",display.recordId);event.dataTransfer.effectAllowed="move";}}
        onDragEnd={finishDrag}>⠿</button>
      {display.childCount>0 && <button className="todo-tree-toggle" aria-label={(collapsed.has(display.recordId)?"展开":"折叠")+"子待办："+display.text}
        aria-expanded={!collapsed.has(display.recordId)} onClick={()=>setCollapsed(previous=>{const next=new Set(previous);if(next.has(display.recordId))next.delete(display.recordId);else next.add(display.recordId);return next;})}>{collapsed.has(display.recordId)?"▸":"▾"}</button>}
      <input type="checkbox" aria-label={display.status === "completed" ? "已完成任务" : display.status === "unknown" ? "任务状态待核对" : "未完成任务"} checked={display.status === "completed"} title={!display.canComplete && display.status !== "completed" ? "请先完成所有子待办" : undefined} disabled={conflictedIds.includes(display.recordId) || display.status === "unknown" || progress.locked(display.recordId) || (display.status !== "completed" && !display.canComplete)} onChange={() => { const record = records.find((item) => item.recordId === display.recordId); if (record) void progress.mutate(record, { kind: "complete", completed: display.status !== "completed" }); }} />
      <div><button className="todo-open" disabled={conflictedIds.includes(display.recordId)} onClick={(event) => { const found = records.find((record) => record.recordId === display.recordId); if (found) { origin.current = event.currentTarget; setSelected(found); } }}>{display.text}</button>
        {display.dateLabel && <span className={display.dateLabel.startsWith("已逾期") ? "todo-date overdue" : "todo-date"}>{display.dateLabel}</span>}
        {display.warning && <p role="alert">{display.warning}</p>}
        {progress.locked(display.recordId) && <p role="status">{progress.states.get(display.recordId)?.message}</p>}
        {progress.states.get(display.recordId)?.phase === "uncertain" && <button onClick={() => void progress.retry(display.recordId)}>核对原任务操作</button>}
        {progress.states.get(display.recordId)?.phase === "failed" && <p role="alert">{progress.states.get(display.recordId)?.message}</p>}</div>
    </li>;
  }
  return <section className="todo-capture" data-testid="todo-capture">
    <div inert={!!selected}>
    <header className="capture-toolbar"><strong>待办随手记</strong><button onClick={() => void window.workspaceSetup.windowAction(pinned ? "unpin" : "pin").then(() => setPinned(!pinned))}>{pinned ? "取消置顶" : "窗口置顶"}</button><button onClick={onManagement}>工作空间管理</button></header>
    <label htmlFor="todo-text">任务内容</label><textarea id="todo-text" ref={input} value={text} rows={3} readOnly={busy || uncertain} aria-busy={busy}
      placeholder="只需写下要做的事…" onChange={(e) => { setText(e.target.value); attempt.current = null; setMessage(""); }}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !composing.current && e.keyCode !== 229) { e.preventDefault(); void save(); } }} />
    <button className="primary" disabled={busy} onClick={() => void save()}>{busy ? "正在保存…" : uncertain ? "核对并重试原提交" : "添加待办"}</button>
    <p role="status" data-testid="todo-save-status">{message || "仅本机保存确认后清空文字；接续情况见同步状态。"}</p>
    <p className="scope-note">Enter 添加 · Shift+Enter 换行 · 中文选词不提交</p>
    <ConflictPanel ref={conflicts} onPending={setConflictedIds} />
    <section className="todo-review" aria-label="待办列表">
      <div className="review-heading"><h2>未完成</h2><button disabled={busy || loadState === "loading"} onClick={() => void load()}>重新读取列表</button></div>
      <p className="scope-note">本机任务 · 接续情况见同步状态</p>
      <p role="status" data-testid="todo-list-loading" style={{minHeight:18}}>{loadState === "loading" ? "正在读取待办…" : ""}</p>
      <p role="status" data-testid="todo-progress-notice" style={{minHeight:18}}>{progress.notice}</p>
      {listError && <p role="alert" data-testid="todo-list-error">{listError}</p>}
      {loadState === "ready" && records.filter((record) => !record.deleted).length === 0 && <p>还没有任务，添加第一条待办吧。</p>}
      <p className="scope-note">拖动 ⠿：条目之间调整优先顺序，条目中央成为子待办。</p>
      <><div className="todo-root-drop" data-dragging={!!dragged} role="region" aria-label="移到顶层"
        onDragOver={event=>{event.preventDefault();setDropHint({id:null,position:"after"});}}
        onDrop={event=>{event.preventDefault();moveTo(null,"after");}}>移到顶层（包含全部子待办）</div>
        <p role="status">{dropHint ? dropHint.id===null ? "释放后移到顶层" : dropHint.position==="inside" ? "释放后成为该事项的子待办" : "释放后调整同级顺序" : "拖向事项或列表间隙"}</p></>
      <div className="todo-review-list" data-testid="todo-review-scroll">
        <ul className="capture-records" data-testid="unfinished-todos">{visible(groups.unfinished).map(row)}</ul>
        {loadState === "ready" && !groups.unfinished.length && <p>暂无未完成任务</p>}
        <button className="completed-toggle" title="数量按顶层目标计算；展开可查看全部子待办" aria-expanded={expanded} aria-controls="completed-todo-list" onClick={() => setExpanded(!expanded)}>已完成（{groups.completedRoots}）</button>
        <ul id="completed-todo-list" className="capture-records" data-testid="completed-todos" hidden={!expanded}>{visible(groups.completed).map(row)}</ul>
      </div>
    </section>
    </div>
    {selected && <TodoDetails records={records} canComplete={[...groups.unfinished,...groups.completed].find(n=>n.recordId===selected.recordId)?.canComplete ?? false} conflicted={conflictedIds.includes(selected.recordId)} ref={details} progress={progress} key={selected.recordId} snapshot={selected} today={today} onClose={closeDetails} onMissing={(recordId) => setRecords((current) => current.filter((record) => record.recordId !== recordId))} />}
  </section>;
});
