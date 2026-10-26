import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ContentValue, DomainEntry, JsonObject, ResolutionChoice, RetainedConflict } from "@workspace/contracts";
import type { DomainViewHandle } from "./domain-view.js";

function describe(value: ContentValue) {
  if (value === null) return "已删除";
  return `${String(value.text ?? "内容不可读")}\n截止日期：${String(value.dueDate ?? "未设置")}\n${value.completed ? "已完成 · " + String(value.completedAt ?? "时间不可读") : "未完成"}`;
}

export const ConflictPanel = forwardRef<DomainViewHandle, { domain?: DomainEntry; onPending(ids: readonly string[]): void }>(function ConflictPanel({ onPending, domain }, ref) {
  const domainId = domain?.definition.domainId ?? "builtin.todo";
  const format = (value: ContentValue) => !domain || value === null ? describe(value) : domain.definition.view.fields.map((key) => key + "：" + String(value[key] ?? "未设置")).join("\n");
  const [items, setItems] = useState<readonly RetainedConflict[]>([]);
  const [selected, setSelected] = useState<RetainedConflict | null>(null);
  const [choice, setChoice] = useState<ResolutionChoice | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [closing, setClosing] = useState(false);
  const current = useRef<RetainedConflict | null>(null);
  const desired = useRef<ResolutionChoice | null>(null);
  const unsaved = useRef(false);
  const queue = useRef(Promise.resolve(true));
  const pending = useRef(0);
  const frozen = useRef<{ operationId: string; choice: ResolutionChoice; generation: number; submitted: boolean } | null>(null);
  async function load() {
    try {
      const result = await window.workspaceSetup.domains({ action: "conflict-list", domainId });
      if (!result.ok) { setMessage(result.message); return; }
      if (!result.conflicts) return;
      setItems(result.conflicts); onPending([...new Set(result.conflicts.flatMap(item=>item.atomicGroup?.records??[item.recordId]))]);
    } catch { setMessage("冲突材料暂不可读，已有整理内容保留。"); }
  }
  useEffect(() => { void load(); const resume = () => void load(); window.addEventListener("focus", resume); window.addEventListener("workspace:replica-updated", resume); return () => { window.removeEventListener("focus", resume); window.removeEventListener("workspace:replica-updated", resume); }; }, []);
  function open(item: RetainedConflict) {
    current.current = item; desired.current = item.draft?.choice ?? null; frozen.current = null; unsaved.current = false;
    setSelected(item); setChoice(item.draft?.choice ?? null); setMessage("");
  }
  function persist(next: ResolutionChoice, submitted: boolean): Promise<boolean> {
    ++pending.current; setBusy(true); unsaved.current = true;
    queue.current = queue.current.then(async () => {
      const item = current.current;
      if (!item) return false;
      // Lost replies retry the exact frozen choice before accepting further edits.
      const attempt = frozen.current ?? { operationId: crypto.randomUUID(), choice: next, generation: item.generation, submitted };
      frozen.current = attempt;
      try {
        const result = await window.workspaceSetup.domains({ action: "conflict-choice", domainId, recordId: item.recordId, ...attempt });
        if (!result.ok || !result.conflict) {
          if (!result.ok && result.outcome === "not-saved") { frozen.current = null; setUncertain(false); }
          else setUncertain(true);
          setMessage(result.ok ? "保存回执不完整，请核对原选择。" : result.message); return false;
        }
        current.current = result.conflict; setSelected(result.conflict); frozen.current = null; setUncertain(false);
        setItems((list) => list.map((entry) => entry.recordId === item.recordId ? result.conflict! : entry));
        if (desired.current === attempt.choice) unsaved.current = false;
        setMessage(result.message ?? "整理内容已保存在本机。"); return true;
      } catch { setUncertain(true); setMessage("选择保存结果暂不能确认，请保留整理内容并核对原选择。"); return false; }
    }).finally(() => { --pending.current; setBusy(pending.current > 0); });
    return queue.current;
  }
  function edit(next: ResolutionChoice) { desired.current = next; setChoice(next); void persist(next, false); }
  async function close(): Promise<boolean> {
    const requestedChoice = desired.current;
    setClosing(true);
    try {
      await queue.current;
      if (unsaved.current && desired.current && !await persist(desired.current, false)) return false;
      if (desired.current !== requestedChoice || unsaved.current) return false;
      current.current = null; setSelected(null); setChoice(null); return true;
    } finally { setClosing(false); }
  }
  useImperativeHandle(ref, () => ({ get dirty() { return unsaved.current || pending.current > 0; },
    save: async () => { await queue.current; return !unsaved.current || (!!desired.current && await persist(desired.current, false)); },
    discard: () => !unsaved.current && pending.current === 0,
  }));
  const observed = items.find((item) => item.recordId === selected?.recordId);
  const deletion = selected && (selected.comparison.local.value === null || selected.comparison.remote?.value === null);
  const locked = !!selected?.draft?.submitted || uncertain;
  const manual = choice && "value" in choice ? choice.value : null;
  function manualChange(patch: JsonObject) {
    if (!manual || !choice || !["manual", "restore"].includes(choice.kind)) return;
    const value = { ...manual, ...patch };
    if (!domain && value.dueDate === "") delete value.dueDate;
    if (!domain && !value.completed) delete value.completedAt;
    edit({ kind: choice.kind as "manual" | "restore", value });
  }
  return <section className="conflict-panel" data-empty={!items.length && !selected && !message} aria-label="待处理冲突" data-testid="conflict-panel">
    <div className="review-heading"><h2>待处理冲突（{items.length}）</h2><button disabled={busy} onClick={() => void load()}>重新读取冲突</button></div>
    {items.map((item) => <p key={item.recordId}><span>{String(item.comparison.local.value?.[domain?.definition.view.titleField ?? "text"] ?? item.comparison.remote?.value?.[domain?.definition.view.titleField ?? "text"] ?? "已删除内容")} · 待处理，普通修改已暂停</span><button disabled={busy || (!!selected && selected.recordId !== item.recordId)} onClick={() => { if (!selected || !unsaved.current) open(item); }}>处理冲突</button></p>)}
    {selected && <section aria-label="冲突详情" data-testid="conflict-details">
      {observed && observed.generation > selected.generation && <p role="alert">已取得新的冲突进度，当前整理内容保留；请重新比较最新进度。</p>}
      {selected.atomicGroup && <p role="alert">这是包含 {selected.atomicGroup.records?.length??1+(selected.atomicGroup.request.batch?.length??0)} 条事项的整体操作冲突。采用本机或统一位置会对整组采用对应成果；保留删除会保留整组删除结果，恢复原内容会恢复整组事项。下面的手动整理作用于当前冲突事项，其他事项保留对应一方的成果。</p>}
      <h3>同一条内容的差异</h3><p>选择先保存在本机；统一位置确认后才会解决冲突。</p>
      <h4>本机成果</h4><pre>{format(selected.comparison.local.value)}</pre>
      {selected.editorValue && <><h4>尚未提交的编辑</h4><pre>{format(selected.editorValue)}</pre></>}
      <h4>统一位置成果</h4><pre>{selected.comparison.remote ? format(selected.comparison.remote.value) : "材料尚未取得，不能作覆盖选择"}</pre>
      <details><summary>共同进度与已保留材料</summary><pre>{selected.comparison.base ? format(selected.comparison.base.value) : "共同进度不可用"}</pre>
        {selected.remoteHistory.map((version) => <pre key={version.revision}>进度 {version.revision}：{format(version.value)}</pre>)}</details>
      {selected.draft && selected.draft.comparedRevision !== selected.comparison.remote?.revision && <p role="alert">统一位置已有新进度，原整理内容已保留，需重新比较。</p>}
      {locked && <p role="status">选择已提交本机，等待统一位置核对；该内容仍待处理。</p>}
      <fieldset disabled={closing || locked || !selected.comparison.remote}>
        <legend>{deletion ? "明确决定是否恢复原内容" : "选择解决方式"}</legend>
        {(deletion ? ["delete", "restore"] as const : ["local", "remote", "manual"] as const).map((kind) => <button key={kind} disabled={busy} aria-pressed={choice?.kind === kind} onClick={() => {
          if (kind === "manual" || kind === "restore") edit({ kind, value: { ...(selected.editorValue ?? selected.comparison.local.value ?? selected.comparison.remote?.value ?? {}) } });
          else edit({ kind });
        }}>{({ local: "采用本机", remote: "采用统一位置", manual: "手动整理", delete: "保留删除", restore: "恢复原内容并采用编辑结果" })[kind]}</button>)}
        {manual && domain && <div>{domain.definition.view.fields.map((key) => {
          const rule = (domain.definition.schema.properties as JsonObject)[key] as JsonObject;
          return <label key={key}>整理 {key}<input aria-label={"整理 " + key} type={rule.type === "boolean" ? "checkbox" : rule.type === "number" ? "number" : "text"}
            value={rule.type === "boolean" ? undefined : String(manual[key] ?? "")} checked={rule.type === "boolean" ? manual[key] === true : undefined}
            onChange={(event) => manualChange({ [key]: rule.type === "boolean" ? event.target.checked : rule.type === "number" ? Number(event.target.value) : event.target.value })} /></label>;
        })}</div>}
        {manual && !domain && <div><label>整理任务内容<textarea aria-label="整理任务内容" value={String(manual.text ?? "")} onChange={(event) => manualChange({ text: event.target.value })} /></label>
          <label>整理截止日期<input type="date" aria-label="整理截止日期" value={String(manual.dueDate ?? "")} onChange={(event) => manualChange({ dueDate: event.target.value })} /></label>
          <label><input type="checkbox" checked={manual.completed === true} onChange={(event) => manualChange({ completed: event.target.checked, ...(event.target.checked ? { completedAt: new Date().toISOString() } : {}) })} />整理为已完成</label></div>}
        <button disabled={busy || !choice} onClick={() => { if (choice) void persist(choice, true); }}>明确保存解决结果</button>
      </fieldset>
      <button disabled={busy || uncertain || !!selected.draft?.submitted} onClick={() => void window.workspaceSetup.domains({ action: "conflict-list", domainId }).then((result) => {
        if (!result.ok) { setMessage(result.message); return; }
        const latest = result.conflicts?.find((item) => item.recordId === selected.recordId);
        if (latest) { current.current = latest; setSelected(latest); setMessage("已取得最新比较依据，当前整理内容保留，请重新明确提交。"); }
      }).catch(() => setMessage("暂时无法取得最新比较依据，整理内容保留。"))}>重新比较最新进度</button>
      <button disabled={busy || closing} onClick={() => void close()}>稍后处理</button>
      {frozen.current && !busy && <button onClick={() => { if (desired.current) void persist(desired.current, frozen.current?.submitted ?? false); }}>核对原选择保存</button>}
    </section>}
    {message && <p role="status" data-testid="conflict-status">{message}</p>}
  </section>;
});
