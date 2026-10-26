import { LocalStoreError } from "@workspace/contracts";
import type { JsonObject, JsonValue, LocalChange, LocalPersistence, LocalSaveResult, OperationReference } from "@workspace/contracts";

// Keep validation beside the serialization boundary: JSON must never silently drop
// undefined fields, non-finite numbers, accessors or cycles from a saved snapshot.
function copyJson(value: unknown, ancestors = new Set<object>(), depth = 0): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || depth > 128 || ancestors.has(value)) throw new TypeError("Invalid JSON value");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("JSON objects must be plain data");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError("Symbol data cannot be saved");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Array.from({ length: value.length }, (_, i) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !("value" in descriptor)) throw new TypeError("Sparse or accessor array");
        return copyJson(descriptor.value, ancestors, depth + 1);
      });
    }
    const result: JsonObject = Object.create(null) as JsonObject;
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new TypeError("Accessor data cannot be saved");
      result[key] = copyJson(descriptor.value, ancestors, depth + 1);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export class LocalContentService {
  constructor(private readonly persistence: LocalPersistence) {}

  async save(change: LocalChange): Promise<LocalSaveResult> {
    let payloadJson: string | null;
    try {
      if (!change || ![change.workspaceId, change.domainId, change.recordId, change.operationId]
        .every((id) => typeof id === "string" && id.trim().length > 0 && id.length <= 512)) {
        throw new TypeError("Invalid identity");
      }
      if (change.kind === "put") {
        if (!change.payload || Array.isArray(change.payload) || typeof change.payload !== "object") throw new TypeError("Object required");
        payloadJson = JSON.stringify(copyJson(change.payload));
      } else if (change.kind === "delete") {
        payloadJson = null;
      } else {
        throw new TypeError("Invalid change");
      }
    } catch {
      return { status: "not-saved", reason: "invalid-input", message: "内容无法保存，请检查输入。" };
    }

    const operationId = change.operationId;
    try {
      const localSequence = await this.persistence.commit({
        workspaceId: change.workspaceId, domainId: change.domainId, recordId: change.recordId,
        operationId, kind: change.kind, payloadJson,
      });
      return { status: "saved-local", operationId, localSequence };
    } catch (error) {
      if (error instanceof LocalStoreError && error.outcome === "operation-mismatch") {
        return { status: "not-saved", reason: "operation-mismatch", message: "这次操作与原提交不一致，请保留输入并核对。" };
      }
      if (error instanceof LocalStoreError && error.outcome === "not-saved") {
        return { status: "not-saved", reason: "storage-unavailable", message: "未能保存，请保留输入后重试。" };
      }
      return { status: "save-unconfirmed", operationId, message: "尚不能确认保存结果，请保留输入，等待核对。" };
    }
  }

  async recover(reference: OperationReference): Promise<LocalSaveResult> {
    if (!reference || ![reference.workspaceId, reference.domainId, reference.recordId, reference.operationId]
      .every((id) => typeof id === "string" && id.trim().length > 0 && id.length <= 512)) {
      return { status: "not-saved", reason: "invalid-input", message: "操作信息不完整，无法核对保存结果。" };
    }
    const snapshot = { workspaceId: reference.workspaceId, domainId: reference.domainId,
      recordId: reference.recordId, operationId: reference.operationId };
    try {
      const receipt = await this.persistence.readOperation(snapshot);
      if (receipt) return { status: "saved-local", operationId: snapshot.operationId, localSequence: receipt.localSequence };
    } catch {
      // Missing or unavailable receipts cannot prove that an earlier request failed.
    }
    return { status: "save-unconfirmed", operationId: snapshot.operationId, message: "尚不能确认原操作的保存结果，请保留输入后再次核对。" };
  }
}

