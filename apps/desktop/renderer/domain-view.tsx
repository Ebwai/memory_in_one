import { ConflictPanel } from "./conflict-panel.js";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { DomainEntry, JsonObject, LocalRecord } from "@workspace/contracts";

export interface DomainViewHandle { dirty: boolean; save(): Promise<boolean>; discard(): boolean | Promise<boolean> }
export const DomainView = forwardRef<DomainViewHandle, { domain: DomainEntry }>(function DomainView({ domain }, ref) {
  const conflicts = useRef<DomainViewHandle>(null);
  const [conflictedIds, setConflictedIds] = useState<readonly string[]>([]);
  const editorQueue = useRef(Promise.resolve());
  const [records, setRecords] = useState<readonly LocalRecord[]>([]);
  const [payload, setPayload] = useState<JsonObject>({});
  const [baseSequence, setBaseSequence] = useState<number | null>(null);
  const [recordId, setRecordId] = useState<string>(crypto.randomUUID());
  const [operationId, setOperationId] = useState<string>(crypto.randomUUID());
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState("");
  const [deleting, setDeleting] = useState<{ recordId: string; operationId: string } | null>(null);
  async function load() {
    try {
      const result = await window.workspaceSetup.domains({ action: "read-domain", domainId: domain.definition.domainId });
      if (!result.ok) { setMessage(result.message); return; }
      if (result.records) setRecords(result.records);
    } catch { setMessage("读取领域失败，保留已显示内容。"); }
  }
  useEffect(() => { void load(); const updated = () => void load(); window.addEventListener("workspace:replica-updated", updated); return () => window.removeEventListener("workspace:replica-updated", updated); }, []);
  async function discard() { if (busy || uncertain || (conflicts.current && !await conflicts.current.discard())) return false;
    await editorQueue.current;
    const cleared = await window.workspaceSetup.domains({ action: "editor-clear", domainId: domain.definition.domainId, recordId });
    if (!cleared.ok) return false; setPayload({}); setDirty(false); setBaseSequence(null); setRecordId(crypto.randomUUID()); setOperationId(crypto.randomUUID()); return true; }
  async function save(): Promise<boolean> {
    if (conflicts.current?.dirty && !await conflicts.current.save()) return false;
    if (!dirty) return true;
    await editorQueue.current;
    setBusy(true);
    try {
      const result = await window.workspaceSetup.domains({ action: "save-record", domainId: domain.definition.domainId, recordId, operationId, payload, ...(baseSequence === null ? {} : { baseSequence }) });
      if (!result.ok) { setMessage(result.message); return false; }
      if (result.records) setRecords(result.records);
      if (result.save?.status !== "saved-local") {
        setUncertain(result.save?.status !== "not-saved");
        setMessage(result.save?.message ?? "保存结果暂不能确认，请沿原操作核对。"); return false;
      }
      setPayload({}); setDirty(false); setBaseSequence(null); setRecordId(crypto.randomUUID()); setOperationId(crypto.randomUUID()); setUncertain(false);
      setMessage("已保存在本机，待同步。"); return true;
    } catch { setUncertain(true); setMessage("保存结果暂不能确认，请保留当前内容核对原操作。"); return false; }
    finally { setBusy(false); }
  }
  useEffect(() => {
    const record = records.find((entry) => entry.recordId === recordId && !entry.deleted);
    if (!dirty || !record || conflictedIds.includes(recordId)) return;
    editorQueue.current = editorQueue.current.then(async () => {
      try {
        const result = await window.workspaceSetup.domains({ action: "editor-save", domainId: domain.definition.domainId, recordId,
          baseSequence: record.localSequence, operationId: crypto.randomUUID(), draft: payload });
        if (!result.ok) setMessage("编辑保护暂不能确认，当前输入保留。" + result.message);
      } catch { setMessage("编辑保护暂不能确认，当前输入保留。"); }
    });
  }, [payload, dirty, recordId]);
  useImperativeHandle(ref, () => ({ get dirty() { return dirty || !!conflicts.current?.dirty; }, save, discard }));
  return <section className="card" data-testid="domain-view"><h2>{domain.definition.name}</h2>
    <p>内容仅属于 {domain.definition.domainId}。当前展示本机成果，接续情况见同步状态。</p>
    {domain.definition.view.fields.map((field) => {
      const rule = (domain.definition.schema.properties as JsonObject)[field] as JsonObject;
      return <label key={field}>{field}<input aria-label={field} type={rule.type === "boolean" ? "checkbox" : rule.type === "number" ? "number" : "text"}
        value={rule.type === "boolean" ? undefined : String(payload[field] ?? "")} checked={rule.type === "boolean" ? payload[field] === true : undefined} disabled={busy || uncertain || conflictedIds.includes(recordId)}
        onChange={(e) => { setPayload({ ...payload, [field]: rule.type === "boolean" ? e.target.checked : rule.type === "number" ? Number(e.target.value) : e.target.value }); setDirty(true); setOperationId(crypto.randomUUID()); }} /></label>;
    })}
    <button disabled={busy || !dirty || conflictedIds.includes(recordId)} onClick={() => void save()}>{uncertain ? "核对并重试原保存" : "保存领域内容"}</button>
    {message && <p role="status">{message}</p>}
    {deleting && <div role="group" aria-label="确认删除领域内容"><p>确认删除此条内容？{deleting.recordId}</p><button disabled={busy} onClick={() => {
      setBusy(true);
      void window.workspaceSetup.domains({ action: "delete-record", domainId: domain.definition.domainId, ...deleting }).then((result) => {
        if (!result.ok) setMessage(result.message);
        else { if (result.records) setRecords(result.records); setDeleting(null); setMessage("删除已保存在本机，待同步。"); }
      }).catch(() => setMessage("删除结果暂不能确认，请核对原操作。")).finally(() => setBusy(false));
    }}>确认删除此内容</button><button disabled={busy} onClick={() => setDeleting(null)}>取消删除</button></div>}
    <ConflictPanel ref={conflicts} domain={domain} onPending={setConflictedIds} />
    <ul>{records.filter((record) => !record.deleted).map((record) => <li key={record.recordId}>
      <span>{String(record.payload?.[domain.definition.view.titleField] ?? "")}</span>
      <button disabled={busy || dirty || conflictedIds.includes(record.recordId)} onClick={() => { setBusy(true); setPayload(record.payload ?? {}); setRecordId(record.recordId); setBaseSequence(record.localSequence); setOperationId(crypto.randomUUID()); setDirty(true); void window.workspaceSetup.domains({ action: "editor-save", domainId: domain.definition.domainId, recordId: record.recordId, baseSequence: record.localSequence, operationId: crypto.randomUUID(), draft: record.payload ?? {} }).then((result) => { if (!result.ok) { setMessage(result.message); return; } }).catch(() => setMessage("暂时无法保护编辑内容，请重试。")).finally(() => setBusy(false)); }}>编辑</button>
      {domain.definition.actions.includes("delete") && <button disabled={busy || dirty || conflictedIds.includes(record.recordId)} onClick={() => setDeleting({ recordId: record.recordId, operationId: crypto.randomUUID() })}>删除</button>}
    </li>)}</ul>
  </section>;
});
