import { LocalStoreError } from "@workspace/contracts";
import type { JsonObject, LocalPersistence, LocalSaveResult, OperationReference } from "@workspace/contracts";

export type ExistingMutation = { readonly kind: "put"; readonly payload: JsonObject } | { readonly kind: "delete" };

/** Reconstruct from the immutable base operation, never from a possibly newer current record. */
export class ExistingContentService {
  constructor(private readonly persistence: LocalPersistence) {}
  async mutate(reference: OperationReference, baseSequence: number, prepare: (payload: JsonObject) => ExistingMutation): Promise<LocalSaveResult> {
    if (!Number.isSafeInteger(baseSequence) || baseSequence < 1 || ![reference.workspaceId, reference.domainId, reference.recordId, reference.operationId]
      .every((id) => typeof id === "string" && !!id.trim() && id.length <= 512)) {
      return { status: "not-saved", reason: "invalid-input", message: "原任务或操作信息无效，未保存。" };
    }
    let dispatched = false;
    try {
      const prior = await this.persistence.readOperation(reference);
      const current = await this.persistence.readRecord(reference);
      if (!prior && current?.pendingConfirmation) return { status: "not-saved", reason: "operation-mismatch", message: "原同步结果尚待核对，请先立即同步；已保留本机成果与当前输入。" };
      if (!prior && (!current || current.deleted)) return { status: "not-saved", reason: "invalid-input", message: "这条任务已不存在，未将修改转为新增。" };
      if (!prior && current?.localSequence !== baseSequence) return { status: "not-saved", reason: "operation-mismatch", message: "任务已被其他操作修改，请取消本次编辑并重新读取；未覆盖新内容。" };
      const base = (await this.persistence.listPending(reference)).find((item) => item.recordId === reference.recordId && item.localSequence === baseSequence);
      if (!base || base.kind !== "put" || !base.payloadJson) return { status: "not-saved", reason: "invalid-input", message: "无法核对原任务依据，请重新读取任务；未保存。" };
      let mutation: ExistingMutation;
      try { mutation = prepare(JSON.parse(base.payloadJson) as JsonObject); }
      catch (error) { return { status: "not-saved", reason: "invalid-input", message: error instanceof Error ? error.message : "任务修改内容无效。" }; }
      dispatched = true;
      const localSequence = await this.persistence.commit({ ...reference, kind: mutation.kind,
        payloadJson: mutation.kind === "put" ? JSON.stringify(mutation.payload) : null }, baseSequence);
      return { status: "saved-local", operationId: reference.operationId, localSequence };
    } catch (error) {
      if (error instanceof LocalStoreError && error.outcome === "operation-mismatch") return { status: "not-saved", reason: "operation-mismatch", message: "任务或原操作依据已变化，未覆盖已有成果，请重新读取任务。" };
      if (error instanceof LocalStoreError && error.outcome === "not-saved") return { status: "not-saved", reason: "storage-unavailable", message: "本机保存失败，已保留当前输入，请修改或重试。" };
      return { status: "save-unconfirmed", operationId: reference.operationId,
        message: dispatched ? "保存结果尚不能确认，请保留输入并核对原操作。" : "暂时无法核对原操作，请保留输入后再次核对。" };
    }
  }
}
