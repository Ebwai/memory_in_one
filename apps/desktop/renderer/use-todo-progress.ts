import { useRef, useState } from "react";
import type { LocalRecord } from "@workspace/contracts";
import type { TodoCommand } from "@workspace/todo-list";
import type { DomainResponse } from "../bridge/workspace-contracts.js";

export interface ProgressState { phase: "saving" | "uncertain" | "failed" | "saved"; message: string }
interface Attempt { record: LocalRecord; command: TodoCommand; operationId: string; at: string }
export type ProgressResult = { saved: boolean; record?: LocalRecord | null };

export function useTodoProgress(onResult: (result: DomainResponse) => void) {
  const attempts = useRef(new Map<string, Attempt>());
  const current = useRef(new Map<string, ProgressState>());
  const [states, setStates] = useState<ReadonlyMap<string, ProgressState>>(new Map());
  const [notice, setNotice] = useState("");
  function update(id: string, state: ProgressState) { current.current.set(id, state); setStates(new Map(current.current)); setNotice(state.message); }
  const locked = (id: string) => ["saving", "uncertain"].includes(current.current.get(id)?.phase ?? "");
  async function send(attempt: Attempt): Promise<ProgressResult> {
    const id = attempt.record.recordId;
    if (current.current.get(id)?.phase === "saving") return { saved: false };
    update(id, { phase: "saving", message: "正在保存此任务…" });
    try {
      const result = await window.workspaceSetup.domains({ action: "todo-progress", workspaceId: attempt.record.workspaceId, recordId: id,
        operationId: attempt.operationId, baseSequence: attempt.record.localSequence, command: attempt.command, at: attempt.at });
      if (!result.ok) { update(id, { phase: "uncertain", message: result.message + " 请核对原操作。" }); return { saved: false }; }
      onResult(result);
      if (result.save?.status === "saved-local") {
        attempts.current.delete(id);
        update(id, { phase: "saved", message: (attempt.command.kind === "delete" ? "删除已保存在本机，待同步。" : "修改已保存在本机，待同步。") + (result.message ?? "") });
        return { saved: true, ...(result.record !== undefined ? { record: result.record } : {}) };
      }
      const uncertain = result.save?.status !== "not-saved";
      if (!uncertain) attempts.current.delete(id);
      update(id, { phase: uncertain ? "uncertain" : "failed", message: result.save?.message ?? "保存结果尚不能确认，请核对原操作。" });
      return { saved: false, ...(result.record !== undefined ? { record: result.record } : {}) };
    } catch {
      update(id, { phase: "uncertain", message: "保存结果尚不能确认，请核对原操作；暂不继续修改此任务。" });
      return { saved: false };
    }
  }
  async function mutate(record: LocalRecord, command: TodoCommand): Promise<ProgressResult> {
    if (locked(record.recordId)) return { saved: false };
    const attempt = { record, command, operationId: crypto.randomUUID(), at: new Date().toISOString() };
    attempts.current.set(record.recordId, attempt);
    return send(attempt);
  }
  async function retry(id: string): Promise<ProgressResult> {
    const attempt = attempts.current.get(id);
    return attempt ? send(attempt) : { saved: false };
  }
  async function settle(): Promise<boolean> {
    for (const [id, state] of current.current) {
      if (state.phase === "saving") return false;
      if (state.phase === "uncertain" && !(await retry(id)).saved) return false;
    }
    return true;
  }
  return { states, notice, locked, mutate, retry, settle, pending: (id: string) => attempts.current.get(id), hasPending: () => [...current.current.values()].some((state) => state.phase === "saving" || state.phase === "uncertain") };
}
