import { todoSubtree, todoSubtreeBasis } from "@workspace/todo-list";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { LocalRecord } from "@workspace/contracts";
import type { DomainViewHandle } from "./domain-view.js";
import type { ProgressResult, useTodoProgress } from "./use-todo-progress.js";
import { prepareTodoMutation, projectTodo } from "@workspace/todo-list";

export const TodoDetails = forwardRef<DomainViewHandle, {
  records: readonly LocalRecord[]; canComplete: boolean; conflicted?: boolean; snapshot: LocalRecord; today: string; onClose(): void; onMissing(recordId: string): void; progress: ReturnType<typeof useTodoProgress>;
}>(function TodoDetails({ snapshot, today, onClose, onMissing, progress, conflicted, records, canComplete }, ref) {
  const [record, setRecord] = useState(snapshot);
  const [phase, setPhase] = useState<"loading" | "ready" | "missing" | "error">(progress.locked(snapshot.recordId) ? "ready" : "loading");
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState<{ kind: "text" | "date"; base: LocalRecord; value: string } | null>(() => {
    const pending = progress.pending(snapshot.recordId);
    if (pending?.command.kind === "text") return { kind: "text", base: pending.record, value: pending.command.text };
    if (pending?.command.kind === "date") return { kind: "date", base: pending.record, value: pending.command.dueDate ?? "" };
    return null;
  });
  const [deleting, setDeleting] = useState<LocalRecord | null>(() => { const pending = progress.pending(snapshot.recordId); return pending?.command.kind === "delete" ? pending.record : null; });
  const [deleteScope, setDeleteScope] = useState<{basis:string;count:number} | null>(null);
  const editing = useRef(false);
  editing.current = !!editor || !!deleting;
  const close = useRef<HTMLButtonElement>(null);
  const dateField = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  const reading = useRef(false);
  const locked = progress.locked(snapshot.recordId) || !!conflicted || !!record.pendingConfirmation;
  const editorQueue = useRef(Promise.resolve(true));
  const state = progress.states.get(snapshot.recordId);
  function requestClose() { if (progress.states.get(snapshot.recordId)?.phase !== "saving") { setEditor(null); setDeleting(null); void editorQueue.current.then(() => window.workspaceSetup.domains({ action: "editor-clear", recordId: snapshot.recordId })); onClose(); } }
  async function refresh() {
    if (reading.current || editing.current || progress.locked(snapshot.recordId)) return;
    reading.current = true; setPhase("loading");
    try {
      const result = await window.workspaceSetup.domains({ action: "todo-detail", recordId: snapshot.recordId });
      if (!active.current) return;
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
    if (result.saved) { setEditor(null); setDeleting(null); setMessage(""); }
  }
  async function beginEditor(kind: "text" | "date") {
    try {
      const result = await window.workspaceSetup.domains({ action: "editor-save", recordId: record.recordId, baseSequence: record.localSequence,
        operationId: crypto.randomUUID(), draft: record.payload ?? {} });
      if (!result.ok) { setMessage(result.message); return; }
      setEditor({ kind, base: record, value: kind === "text" ? String(record.payload?.text ?? "") : String(record.payload?.dueDate ?? "") }); setMessage("");
    } catch { setMessage("暂时无法保护编辑内容，请保留原任务后重试。"); }
  }
  useEffect(() => {
    if (!editor) return;
    const value = { ...editor.base.payload };
    if (editor.kind === "text") value.text = editor.value;
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
  async function saveEditor(): Promise<boolean> {
    await editorQueue.current;
    if (state?.phase === "uncertain") {
      const result = await progress.retry(snapshot.recordId); accept(result); return result.saved;
    }
    if (!editor) return !progress.locked(snapshot.recordId);
    if (editor.kind === "date" && dateField.current && !dateField.current.validity.valid) { setMessage("请输入有效的日历日期，或明确清除为未设置。"); return false; }
    const command = editor.kind === "text" ? { kind: "text" as const, text: editor.value } : { kind: "date" as const, dueDate: editor.value || null };
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
  const display = projectTodo(record, today);
  return <div className="todo-detail-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="todo-detail-title" className="todo-detail" data-testid="todo-details" onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); requestClose(); }
    if (event.key === "Tab") {
      const fields = event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),textarea:not(:disabled)");
      const first = fields[0]; const last = fields[fields.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <header><h2 id="todo-detail-title">待办详情</h2><button ref={close} disabled={state?.phase === "saving"} onClick={requestClose}>关闭详情</button></header>
    {conflicted && <p role="alert">检测到新进度，当前编辑已保留为冲突材料。请关闭详情，从待处理冲突入口继续整理。</p>}
    {record.pendingConfirmation && <p role="alert">原同步结果待核对，请先立即同步；当前输入保留。</p>}
    {phase === "loading" && <p role="status">正在读取任务本机信息…</p>}
    {phase === "missing" ? <p role="alert">这条任务已不存在，请返回列表。</p> : display && <>
      {phase === "error" && <p role="alert">{message}</p>}
      <p className="scope-note">当前显示本机保存成果；接续情况见同步状态。</p>
      <div className="todo-full-text" data-testid="todo-full-text">{display.text}</div>
      <dl><dt>完成状态</dt><dd>{display.status === "completed" ? "已完成" : display.status === "unfinished" ? "未完成" : "无法识别，待核对"}</dd>
        <dt>截止日期</dt><dd>{display.dueState === "unset" ? "未设置" : display.dueState === "invalid" ? "无法识别" : display.dueDate}</dd></dl>
      {display.dateLabel && <p>{display.dateLabel}</p>}
      {display.warning && <p role="alert">{display.warning}</p>}
      {!editor && !deleting && <div className="todo-actions">
        <button disabled={locked || phase !== "ready"} onClick={() => void beginEditor("text")}>编辑内容</button>
        <button disabled={locked || phase !== "ready"} onClick={() => void beginEditor("date")}>设置截止日期</button>
        <button disabled={locked || phase !== "ready" || display.status === "unknown" || (display.status !== "completed" && !canComplete)} title={!canComplete ? "请先完成所有子待办" : undefined} onClick={() => void progress.mutate(record, { kind: "complete", completed: display.status !== "completed" }).then(accept)}>{display.status === "completed" ? "恢复未完成" : "标记完成"}</button>
        <button disabled={locked || phase !== "ready"} onClick={() => {setDeleteScope({basis:todoSubtreeBasis(records,record.recordId),count:todoSubtree(records,record.recordId).length-1});setDeleting(record);}}>删除任务</button>
      </div>}
      {editor && <div data-testid="todo-editor">
        {editor.kind === "text" ? <label>编辑任务内容<textarea aria-label="编辑任务内容" autoFocus value={editor.value} readOnly={locked} onChange={(event) => setEditor({ ...editor, value: event.target.value })} /></label>
          : <><label>截止日期选择<input ref={dateField} type="date" aria-label="截止日期选择" autoFocus value={editor.value} disabled={locked} onChange={(event) => setEditor({ ...editor, value: event.target.value })} /></label><button disabled={locked} onClick={() => setEditor({ ...editor, value: "" })}>清除日期</button></>}
        <button disabled={locked} onClick={() => void saveEditor()}>保存修改</button>
        <button disabled={locked} onClick={() => { setEditor(null); setMessage(""); void editorQueue.current.then(() => window.workspaceSetup.domains({ action: "editor-clear", recordId: snapshot.recordId })); }}>取消编辑</button>
      </div>}
      {deleting && <div role="group" aria-label="确认删除待办" data-testid="todo-delete-confirm">
        <p className="delete-summary">{String(deleting.payload?.text ?? "").slice(0, 200)}{String(deleting.payload?.text ?? "").length > 200 ? "…" : ""}</p>
        <p>{deleteScope && deleteScope.count>0 ? "确认删除此父事项及其全部 "+deleteScope.count+" 条子待办（包含所有层级及已完成事项）？" : "确认删除这条任务？"}删除后没有回收站或撤销删除入口。</p>
        <button disabled={locked} onClick={() => void progress.mutate(deleting, { kind: "delete", confirmed: true, ...(deleteScope ? {subtreeBasis:deleteScope.basis} : {}) }).then((result) => { accept(result); if (active.current && (result.saved || result.record === null)) onClose(); })}>确认删除任务</button>
        <button disabled={locked} onClick={() => setDeleting(null)}>取消删除</button>
      </div>}
    </>}
    {message && phase !== "error" && <p role="alert">{message}</p>}
    {state && <p role="status" data-testid="todo-progress-status">{state.message}</p>}
    {state?.phase === "uncertain" && <button onClick={() => void progress.retry(snapshot.recordId).then((result) => { accept(result); if (result.saved && result.record === null) onClose(); })}>核对原任务操作</button>}
    <button disabled={phase === "loading" || locked || !!editor || !!deleting} onClick={() => void refresh()}>重新读取任务</button>
  </section></div>;
});
