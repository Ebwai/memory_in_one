import { todoSubtree, todoSubtreeBasis } from "@workspace/todo-list";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { LocalRecord } from "@workspace/contracts";
import type { DomainViewHandle } from "./domain-view.js";
import type { ProgressResult, useTodoProgress } from "./use-todo-progress.js";
import { prepareTodoMutation, projectTodo } from "@workspace/todo-list";

export const TodoDetails = forwardRef<DomainViewHandle, {
  initialDelete?: boolean; records: readonly LocalRecord[]; canComplete: boolean; conflicted?: boolean; snapshot: LocalRecord; today: string; onClose(): void; onMissing(recordId: string): void; progress: ReturnType<typeof useTodoProgress>;
}>(function TodoDetails({ initialDelete, snapshot, today, onClose, onMissing, progress, conflicted, records, canComplete }, ref) {
  const [record, setRecord] = useState(snapshot);
  const [phase, setPhase] = useState<"loading" | "ready" | "missing" | "error">(progress.locked(snapshot.recordId) ? "ready" : "loading");
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState<{ kind: "text" | "date" | "notes" | "repeat"; base: LocalRecord; value: string } | null>(() => {
    const pending = progress.pending(snapshot.recordId);
    if (pending?.command.kind === "text") return { kind: "text", base: pending.record, value: pending.command.text };
    if (pending?.command.kind === "date") return { kind: "date", base: pending.record, value: pending.command.dueDate ?? "" };
    if (pending?.command.kind === "notes") return { kind: "notes", base: pending.record, value: pending.command.notes };
    if (pending?.command.kind === "repeat") return { kind: "repeat", base: pending.record, value: JSON.stringify(pending.command) };
    return null;
  });
  const [deleting, setDeleting] = useState<LocalRecord | null>(() => { const pending = progress.pending(snapshot.recordId); return initialDelete ? snapshot : pending?.command.kind === "delete" ? pending.record : null; });
  const [deleteScope, setDeleteScope] = useState<{basis:string;count:number} | null>(() => initialDelete ? { basis: todoSubtreeBasis(records, snapshot.recordId), count: todoSubtree(records, snapshot.recordId).length - 1 } : null);
  const editing = useRef(false);
  editing.current = !!editor || !!deleting;
  const close = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const dateField = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  const reading = useRef(false);
  const startingEditor = useRef(false);
  const locked = progress.locked(snapshot.recordId) || !!conflicted || !!record.pendingConfirmation;
  const editorQueue = useRef(Promise.resolve(true));
  const editorEpoch = useRef(0);
  const savingEditor = useRef<Promise<boolean> | null>(null);
  const state = progress.states.get(snapshot.recordId);
  async function requestClose() { if (progress.states.get(snapshot.recordId)?.phase === "saving") return; if (progress.states.get(snapshot.recordId)?.phase === "uncertain") { onClose(); return; } if (editor && !await saveEditor()) return; await editorQueue.current; await window.workspaceSetup.domains({ action: "editor-clear", recordId: snapshot.recordId }); setDeleting(null); onClose(); }
  async function refresh() {
    if (reading.current || editing.current || progress.locked(snapshot.recordId)) return;
    reading.current = true;
    try {
      const result = await window.workspaceSetup.domains({ action: "todo-detail", recordId: snapshot.recordId });
      if (!active.current || editing.current || startingEditor.current) return;
      if (!result.ok) { setPhase("error"); setMessage("无法读取最新本机信息，以下保留此前可确认内容。" + result.message); }
      else if (result.record === null) { setPhase("missing"); onMissing(snapshot.recordId); }
      else if (result.record?.recordId === snapshot.recordId) { setRecord(result.record); setPhase("ready"); setMessage(""); }
      else { setPhase("error"); setMessage("读取信息不完整，以下保留此前可确认内容。"); }
    } catch { if (active.current) { setPhase("error"); setMessage("无法读取最新本机信息，以下保留此前可确认内容。"); } }
    finally { reading.current = false; }
  }
  function accept(result: ProgressResult) {
    if (!active.current) return;
    if (result.record === null) { setPhase("missing"); onMissing(snapshot.recordId); }
    else if (result.record) { setRecord(result.record); setPhase("ready"); }
    if (result.saved) { setEditor(null); setDeleting(null); setMessage("");  }
  }
  async function beginEditor(kind: "text" | "date" | "notes" | "repeat") {
    if (conflicted || deleting || startingEditor.current || editor?.kind === kind) return;
    startingEditor.current = true;
    try {
      if (savingEditor.current) { if (!await savingEditor.current) return; }
      else if (editor && !await saveEditor()) return;
      if (!active.current || progress.locked(snapshot.recordId)) return;
      const latest = await window.workspaceSetup.domains({action:"todo-detail",recordId:record.recordId});
      if (!latest.ok || !latest.record) { setMessage(latest.message ?? "无法读取任务，请重试。"); return; }
      const base = latest.record;
      if (base.pendingConfirmation) { setMessage("原同步结果待核对，请先立即同步。"); return; }
      const result = await window.workspaceSetup.domains({ action: "editor-save", recordId: base.recordId, baseSequence: base.localSequence,
        operationId: crypto.randomUUID(), draft: base.payload ?? {} });
      if (!result.ok) { setMessage(result.message); return; }
      setRecord(base); setPhase("ready");
      setEditor({ kind, base, value: kind === "repeat" ? JSON.stringify({ frequency: base.payload?.repeatFrequency ?? null, target: base.payload?.repeatTarget ?? 1, timezone: base.payload?.repeatTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone }) : String(base.payload?.[kind === "date" ? "dueDate" : kind] ?? "") }); setMessage("");
    } catch { setMessage("暂时无法保护编辑内容，请保留原任务后重试。"); }
    finally { startingEditor.current = false; }
  }
  useEffect(() => {
    if (!editor) return;
    const value = { ...editor.base.payload };
    if (editor.kind === "notes") value.notes = editor.value;
    else if (editor.kind === "repeat") {
      try { const mutation = prepareTodoMutation(value, { ...JSON.parse(editor.value), kind: "repeat" }, new Date().toISOString()); if (mutation.kind === "put") { for (const key of Object.keys(value)) delete value[key]; Object.assign(value, mutation.payload); } } catch { /* Keep draft even while a number is being edited. */ }
    }
    else if (editor.kind === "text") value.text = editor.value;
    else if (editor.value) value.dueDate = editor.value;
    else delete value.dueDate;
    editorQueue.current = editorQueue.current.then(async () => {
      try {
        const result = await window.workspaceSetup.domains({ action: "editor-save", recordId: snapshot.recordId, baseSequence: editor.base.localSequence,
          operationId: crypto.randomUUID(), draft: value });
        if (!result.ok && active.current) setMessage("编辑保护暂不能确认，当前输入保留。" + result.message);
        return result.ok;
      } catch { if (active.current) setMessage("编辑保护暂不能确认，当前输入保留。"); return false; }
    });
  }, [editor]);
  function saveEditor(): Promise<boolean> {
    if (savingEditor.current) return savingEditor.current;
    const saving = commitEditor(); savingEditor.current = saving;
    void saving.finally(() => { if (savingEditor.current === saving) savingEditor.current = null; });
    return saving;
  }
  async function commitEditor(): Promise<boolean> {
    const epoch = editorEpoch.current;
    await editorQueue.current;
    if (epoch !== editorEpoch.current) return false;
    if (state?.phase === "uncertain") {
      const result = await progress.retry(snapshot.recordId); accept(result); return result.saved;
    }
    if (!editor) return !progress.locked(snapshot.recordId);
    if (editor.kind === "date" && dateField.current && !dateField.current.validity.valid) { setMessage("请输入有效的日历日期，或明确清除为未设置。"); return false; }
    const command = editor.kind === "repeat" ? { ...JSON.parse(editor.value), kind: "repeat" as const } : editor.kind === "notes" ? { kind: "notes" as const, notes: editor.value } : editor.kind === "text" ? { kind: "text" as const, text: editor.value } : { kind: "date" as const, dueDate: editor.value || null };
    try { prepareTodoMutation(editor.base.payload ?? {}, command, new Date().toISOString()); }
    catch (error) { setMessage(error instanceof Error ? error.message : "修改内容无效。"); return false; }
    const result = await progress.mutate(editor.base, command); accept(result); return result.saved;
  }
  useImperativeHandle(ref, () => ({
    dirty: !!editor || progress.locked(snapshot.recordId),
    save: saveEditor,
    discard: async () => { if (progress.locked(snapshot.recordId)) return false; await editorQueue.current; const result = await window.workspaceSetup.domains({ action: "editor-clear", recordId: snapshot.recordId }); if (!result.ok) return false; setEditor(null); setDeleting(null); return true; },
  }));
  useEffect(() => {
    active.current = true; close.current?.focus(); void refresh();
    const resume = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("workspace:replica-updated", resume); window.addEventListener("focus", resume); document.addEventListener("visibilitychange", resume);
    return () => { active.current = false; window.removeEventListener("workspace:replica-updated", resume); window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume); };
  }, [snapshot.recordId]);
  function cancelEditor() { if (progress.locked(snapshot.recordId)) return; ++editorEpoch.current; setEditor(null); setMessage(""); void editorQueue.current.then(() => window.workspaceSetup.domains({ action: "editor-clear", recordId: snapshot.recordId })); }
  function fieldEditor() { if (!editor) return null; return (<div data-testid="todo-editor" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void saveEditor(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelEditor(); } if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229 && editor?.kind !== "repeat") { event.preventDefault(); void saveEditor(); } }}>

        {editor.kind === "repeat" ? (() => { const config = JSON.parse(editor.value); const update = (patch: object) => setEditor({...editor,value:JSON.stringify({...config,...patch})}); return <><label>刷新周期<select autoFocus aria-label="刷新周期" disabled={locked} value={config.frequency ?? ""} onChange={e=>update({frequency:e.target.value || null})}><option value="">不重复</option><option value="day">每天零点</option><option value="week">每周一零点</option><option value="month">每月一日零点</option></select></label><label>每周期次数<input aria-label="每周期次数" type="number" min={1} max={1000} step={1} disabled={locked || !config.frequency} value={config.target} onChange={e=>update({target:Number(e.target.value)})}/></label><p>调整重复设置后，本周期进度归零。按 {config.timezone} 时间刷新。</p></>; })() : editor.kind === "notes" ? <label>任务备注<textarea aria-label="任务备注" autoFocus value={editor.value} readOnly={locked} onChange={e=>setEditor({...editor,value:e.target.value})}/></label> : editor.kind === "text" ? <label>编辑任务内容<textarea aria-label="编辑任务内容" autoFocus value={editor.value} readOnly={locked} onChange={(event) => setEditor({ ...editor, value: event.target.value })} /></label>

          : <><label>截止日期选择<input ref={dateField} type="date" aria-label="截止日期选择" autoFocus value={editor.value} disabled={locked} onChange={(event) => setEditor({ ...editor, value: event.target.value })} /></label><button disabled={locked} onClick={() => setEditor({ ...editor, value: "" })}>清除日期</button></>}


      </div>); }
  const display = projectTodo(record, today);
  return <div className="todo-detail-backdrop"><div className="inspector-date">{new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", weekday: "short" }).format(new Date())}<span aria-hidden="true">✣</span></div><section ref={panel} role="dialog" aria-modal="true" aria-labelledby="todo-detail-title" className="todo-detail" data-testid="todo-details" onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); requestClose(); }
    if (event.key === "Tab") {
      const fields = event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)");
      const first = fields[0]; const last = fields[fields.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <header><h2 id="todo-detail-title">待办详情</h2><button ref={close} onMouseDown={e => e.preventDefault()} disabled={state?.phase === "saving"} onClick={() => void requestClose()}>关闭详情</button></header>
    {conflicted && <p role="alert">检测到新进度，当前编辑已保留为冲突材料。请关闭详情，从待处理冲突入口继续整理。</p>}
    {record.pendingConfirmation && <p role="alert">原同步结果待核对，请先立即同步；当前输入保留。</p>}

    {phase === "missing" ? <p role="alert">这条任务已不存在，请返回列表。</p> : display && <>
      {phase === "error" && <p role="alert">{message}</p>}
      <p className="scope-note">当前显示本机保存成果；接续情况见同步状态。</p>
      {editor?.kind === "text" ? fieldEditor() : <div className="todo-full-text direct-edit" tabIndex={0} aria-label="任务内容，双击编辑" data-testid="todo-full-text" onDoubleClick={() => void beginEditor("text")} onKeyDown={e => { if (e.key === "Enter") void beginEditor("text"); }}>{display.text}</div>}
      <p className="inspector-status">□　{display.status === "completed" ? "已完成" : display.status === "unfinished" ? "进行中" : "无法识别，待核对"}</p>
      <div className="inspector-field"><h3>▧　备注</h3>{editor?.kind === "notes" ? fieldEditor() : <div className="inspector-value inspector-notes direct-edit" tabIndex={0} onDoubleClick={() => void beginEditor("notes")} onKeyDown={e => { if (e.key === "Enter") void beginEditor("notes"); }}>{display.notes || "双击添加备注…"}</div>}</div>
      <div className="inspector-field"><h3>▦　截止日期</h3>{editor?.kind === "date" ? fieldEditor() : <div className="inspector-value direct-edit" tabIndex={0} onDoubleClick={() => void beginEditor("date")} onKeyDown={e => { if (e.key === "Enter") void beginEditor("date"); }}>{display.dueState === "unset" ? "未设置" : display.dueState === "invalid" ? "无法识别" : display.dueDate}</div>}</div>
      <div className="inspector-field"><h3>⟳　重复规则</h3>{editor?.kind === "repeat" ? fieldEditor() : <div className="inspector-value direct-edit" tabIndex={0} onDoubleClick={() => void beginEditor("repeat")} onKeyDown={e => { if (e.key === "Enter") void beginEditor("repeat"); }}>{display.repeatFrequency ? ({ day: "每日", week: "每周", month: "每月" } as Record<string,string>)[display.repeatFrequency] : "不重复"}</div>}</div>
      {display.repeatFrequency && <p>重复进度：{display.repeatCount}/{display.repeatTarget} · {({day:"每日",week:"每周",month:"每月"} as Record<string,string>)[display.repeatFrequency]}刷新</p>}
      {display.dateLabel && <p>{display.dateLabel}</p>}
      {display.warning && <p role="alert">{display.warning}</p>}
      {!editor && !deleting && <div className="todo-actions">

        <button disabled={locked || phase !== "ready" || display.status === "unknown" || (display.status !== "completed" && !canComplete)} title={!canComplete ? "请先完成所有子待办" : undefined} onClick={() => void progress.mutate(record, { kind: "complete", completed: display.status !== "completed" }).then(accept)}>{display.status === "completed" ? "恢复未完成" : display.repeatFrequency ? "完成一次" : "标记完成"}</button>
        <button disabled={locked || phase !== "ready"} onClick={() => {setDeleteScope({basis:todoSubtreeBasis(records,record.recordId),count:todoSubtree(records,record.recordId).length-1});setDeleting(record);}}>删除任务</button>
      </div>}
      {deleting && <div role="group" aria-label="确认删除待办" data-testid="todo-delete-confirm">
        <p className="delete-summary">{String(deleting.payload?.text ?? "").slice(0, 200)}{String(deleting.payload?.text ?? "").length > 200 ? "…" : ""}</p>
        <p>{deleteScope && deleteScope.count>0 ? "确认删除此父事项及其全部 "+deleteScope.count+" 条子待办（包含所有层级及已完成事项）？" : "确认删除这条任务？"}删除后没有回收站或撤销删除入口。</p>
        <button disabled={locked} onClick={() => void progress.mutate(deleting, { kind: "delete", confirmed: true, ...(deleteScope ? {subtreeBasis:deleteScope.basis} : {}) }).then((result) => { accept(result); if (active.current && (result.saved || result.record === null)) onClose(); })}>确认删除任务</button>
        <button disabled={locked} onClick={() => setDeleting(null)}>取消删除</button>
      </div>}
    </>}
    {message && phase !== "error" && <p role="alert">{message}</p>}
    {state && (state.phase === "failed" || state.phase === "uncertain") && <p role="status" data-testid="todo-progress-status">{state.message}</p>}
    {state?.phase === "uncertain" && <button onClick={() => void progress.retry(snapshot.recordId).then((result) => { accept(result); if (result.saved && result.record === null) onClose(); })}>核对原任务操作</button>}

  </section></div>;
});
