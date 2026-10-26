import type { LocalSaveResult, OperationReference, PendingOperation } from "@workspace/contracts";

export type SyncPhase = "syncing" | "synced" | "sync-failed" | "sync-unconfirmed" | "conflict";
export type SavePhase = "unsaved" | "saving" | "local-failed" | "local-unconfirmed" | "pending" | SyncPhase;
export interface SaveStatusState extends OperationReference {
  readonly phase: SavePhase;
  readonly localSequence: number | null;
  readonly syncAttempt: number;
  readonly failureReason: Extract<LocalSaveResult, { status: "not-saved" }>["reason"] | null;
}

export function sameOperation(a: OperationReference, b: OperationReference): boolean {
  return a.workspaceId === b.workspaceId && a.domainId === b.domainId && a.recordId === b.recordId && a.operationId === b.operationId;
}

export function createSaveStatus(reference: OperationReference): SaveStatusState {
  return { workspaceId: reference.workspaceId, domainId: reference.domainId, recordId: reference.recordId,
    operationId: reference.operationId, phase: "unsaved", localSequence: null, syncAttempt: 0, failureReason: null };
}

export function startLocalSave(state: SaveStatusState): SaveStatusState {
  return state.phase === "unsaved" || state.phase === "local-failed" ? { ...state, phase: "saving", failureReason: null } : state;
}

export function applyLocalResult(state: SaveStatusState, reference: OperationReference, result: LocalSaveResult): SaveStatusState {
  if (!sameOperation(state, reference) || !["saving", "local-failed", "local-unconfirmed"].includes(state.phase)) return state;
  if (result.status !== "not-saved" && result.operationId !== reference.operationId) return state;
  if (result.status === "saved-local") {
    if (!Number.isSafeInteger(result.localSequence) || result.localSequence <= 0) return { ...state, phase: "local-unconfirmed" };
    return { ...state, phase: "pending", localSequence: result.localSequence, failureReason: null };
  }
  if (result.status === "not-saved") return { ...state, phase: "local-failed", failureReason: result.reason };
  return { ...state, phase: "local-unconfirmed", failureReason: null };
}

export function restoreLocalStatus(receipt: PendingOperation): SaveStatusState {
  if (!Number.isSafeInteger(receipt.localSequence) || receipt.localSequence <= 0) throw new Error("Invalid local receipt");
  return { ...createSaveStatus(receipt), phase: "pending", localSequence: receipt.localSequence };
}

export function applySyncStatus(state: SaveStatusState, event: OperationReference & {
  readonly localSequence: number; readonly attempt: number; readonly phase: SyncPhase;
}): SaveStatusState {
  if (!sameOperation(state, event) || state.localSequence === null || state.localSequence !== event.localSequence ||
    !["pending", "syncing", "synced", "sync-failed", "sync-unconfirmed", "conflict"].includes(state.phase) ||
    !Number.isSafeInteger(event.attempt) || event.attempt <= 0 || event.attempt < state.syncAttempt) return state;
  if (event.attempt === state.syncAttempt && state.phase === "synced") return state;
  return { ...state, phase: event.phase, syncAttempt: event.attempt };
}

export interface SaveStatusPresentation {
  readonly title: string;
  readonly detail: string;
  readonly tone: "neutral" | "progress" | "success" | "warning" | "danger";
  readonly action: "retry-local" | "check-result" | "retry-sync" | "resolve-conflict" | null;
  readonly localSaved: boolean;
}

export function projectSaveStatus(state: SaveStatusState): SaveStatusPresentation {
  switch (state.phase) {
    case "unsaved": return { title: "未保存", detail: "当前输入尚未保存在本机。", tone: "neutral", action: null, localSaved: false };
    case "saving": return { title: "本机保存中", detail: "正在保存，请保留输入，等待确认。", tone: "progress", action: null, localSaved: false };
    case "local-failed": return { title: "本机保存失败", detail: state.failureReason === "operation-mismatch"
      ? "这次操作与原提交不一致，请保留输入并核对。" : "输入仍保留在此处，请检查后重新保存。",
      tone: "danger", action: state.failureReason === "storage-unavailable" ? "retry-local" : null, localSaved: false };
    case "local-unconfirmed": return { title: "结果待确认", detail: "尚不能确认本机保存结果，请保留输入并核对原操作。",
      tone: "warning", action: "check-result", localSaved: false };
    case "pending": return { title: "已保存在本机，待同步", detail: "本机内容已可靠保存，尚未确认统一位置接受。", tone: "neutral", action: null, localSaved: true };
    case "syncing": return { title: "同步中", detail: "本机内容已保存，正在与统一位置确认进度。", tone: "progress", action: null, localSaved: true };
    case "synced": return { title: "已同步至统一位置", detail: "统一位置已确认这次改动，不表示每台其他设备都已取得。", tone: "success", action: null, localSaved: true };
    case "sync-failed": return { title: "同步失败", detail: "本机内容仍保留，同步尚未完成，无需重新输入。", tone: "danger", action: "retry-sync", localSaved: true };
    case "sync-unconfirmed": return { title: "结果待确认", detail: "本机内容已保存，统一位置是否接受仍需核对。", tone: "warning", action: "check-result", localSaved: true };
    case "conflict": return { title: "存在冲突，待处理", detail: "已保留相关成果，请处理冲突后再确认统一进度。", tone: "warning", action: "resolve-conflict", localSaved: true };
  }
}

