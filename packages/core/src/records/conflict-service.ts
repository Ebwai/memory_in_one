import type { Comparison, ConfirmedVersion, ConflictPersistence, ConflictPolicy, ContentValue, LocalPersistence, RecordScope, ResolutionChoice, RetainedConflict } from "@workspace/contracts";
import { compareContent, sameValue } from "./merge.js";

export interface ResolutionAuthority {
  // The implementation must authenticate the scope, CAS the confirmed revision,
  // and persist the operation receipt together with its accepted content.
  accept(scope: RecordScope, operationId: string, expectedRevision: number, value: ContentValue): Promise<
    { readonly status: "accepted"; readonly version: ConfirmedVersion } |
    { readonly status: "changed"; readonly version: ConfirmedVersion }>;
}

export class ConflictService {
  constructor(private readonly store: ConflictPersistence & Pick<LocalPersistence, "readRecord">, private readonly policy?: ConflictPolicy) {}

  async retain(input: Comparison, expectedSequence: number): Promise<RetainedConflict> {
    const previous = await this.store.readConflict(input);
    if (previous?.status === "resolved") {
      if (!input.remote || input.remote.revision <= (previous.comparison.remote?.revision ?? 0)) return previous;
      const decision = compareContent(input, this.policy);
      if (decision.status !== "conflict") throw new Error("该差异可安全合并，应接续原内容。");
      const next: RetainedConflict = { ...previous, generation: previous.generation + 1, status: "pending", comparison: input,
        reasons: decision.reasons, draft: null, remoteHistory: [...previous.remoteHistory, input.remote] };
      const record = await this.store.readRecord(input);
      if (!record || !sameValue(record.deleted ? null : record.payload, input.local.value)) throw new Error("本机内容已变化，请重新比较。");
      await this.store.writeConflict(next, previous.generation, expectedSequence);
      return next;
    }
    if (previous) {
      if (input.remote) return this.appendRemote(previous, input.remote);
      return previous;
    }
    const decision = compareContent(input, this.policy);
    if (decision.status !== "conflict") throw new Error("该差异可安全合并，应接续原内容。");
    const value: RetainedConflict = { workspaceId: input.workspaceId, domainId: input.domainId, recordId: input.recordId,
      generation: 1, comparison: input, reasons: decision.reasons, remoteHistory: input.remote ? [input.remote] : [], draft: null, status: "pending" };
    await this.store.writeConflict(value, null, expectedSequence);
    return value;
  }

  private async appendRemote(current: RetainedConflict, version: ConfirmedVersion): Promise<RetainedConflict> {
    const latest = current.comparison.remote;
    if (latest && version.revision <= latest.revision) {
      if (version.revision === latest.revision && !sameValue(version.value, latest.value)) throw new Error("统一位置进度依据不一致，原材料保留。");
      return current;
    }
    const value: RetainedConflict = { ...current, status: "pending", generation: current.generation + 1,
      comparison: { ...current.comparison, remote: version }, remoteHistory: [...current.remoteHistory, version] };
    await this.store.writeConflict(value, current.generation);
    return value;
  }

  async protectEditor(editor: import("@workspace/contracts").EditorDraft, remote: ConfirmedVersion, record: import("@workspace/contracts").LocalRecord): Promise<void> {
    const current = await this.store.readConflict(editor);
    if (current?.status === "pending") { await this.appendRemote(current, remote); return; }
    const comparison: Comparison = { workspaceId: editor.workspaceId, domainId: editor.domainId, recordId: editor.recordId,
      base: editor.base ?? null, local: { baseRevision: editor.base?.revision ?? 0, value: record.deleted ? null : record.payload, changed: [] },
      remote, remoteChanged: [] };
    const next: RetainedConflict = { workspaceId: editor.workspaceId, domainId: editor.domainId, recordId: editor.recordId,
      generation: (current?.generation ?? 0) + 1, comparison, reasons: ["unsaved-editor"], remoteHistory: [remote],
      editorValue: editor.value, draft: null, status: "pending" };
    await this.store.writeConflict(next, current?.generation ?? null, record.localSequence);
  }

  async saveChoice(scope: RecordScope, generation: number, operationId: string, choice: ResolutionChoice, submitted: boolean): Promise<RetainedConflict> {
    const current = await this.store.readConflict(scope);
    if (!current || current.status !== "pending") throw new Error("没有待处理冲突，请重新读取。");
    // A retry of a frozen request returns its original durable receipt.
    if (current.draft?.operationId === operationId) {
      if (!sameValue(current.draft.choice as unknown as import("@workspace/contracts").JsonValue, choice as unknown as import("@workspace/contracts").JsonValue) || current.draft.submitted !== submitted) throw new Error("原选择操作身份不能用于其他结果。");
      return current;
    }
    if (current.generation !== generation || current.draft?.submitted) throw new Error("比较已变化或原提交尚待核对，整理内容保留，请重新读取。");
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(operationId)) throw new Error("选择操作身份无效。");
    if (!choice || !["local", "remote", "manual", "delete", "restore"].includes(choice.kind) ||
        (("value" in choice) && (!choice.value || typeof choice.value !== "object" || Array.isArray(choice.value))) ||
        (["manual", "restore"].includes(choice.kind) && !("value" in choice))) throw new Error("冲突选择格式无效，整理内容保留。");
    const { comparison } = current;
    if (!comparison.remote || !this.policy) throw new Error("另一方材料或领域程序不完整，暂不能作覆盖选择。");
    const deleted = comparison.local.value === null || comparison.remote.value === null;
    if (deleted ? !["delete", "restore"].includes(choice.kind) : !["local", "remote", "manual"].includes(choice.kind)) throw new Error("请选择明确的冲突处理方式；删除冲突需要明确保留删除或恢复原内容。");
    const value = choice.kind === "local" ? comparison.local.value : choice.kind === "remote" ? comparison.remote.value : choice.kind === "delete" ? null : ("value" in choice ? choice.value : null);
    if (submitted) this.policy.validate(value, comparison.base?.value ?? comparison.local.value ?? comparison.remote.value);
    const next: RetainedConflict = { ...current, generation: generation + 1,
      draft: { operationId, comparedRevision: comparison.remote.revision, choice, value, submitted } };
    await this.store.writeConflict(next, generation);
    return next;
  }

  async submit(scope: RecordScope, authority?: ResolutionAuthority): Promise<"pending" | "changed" | "resolved"> {
    const current = await this.store.readConflict(scope);
    if (!current) throw new Error("没有可核对的冲突材料。");
    if (current.status === "resolved") return "resolved";
    const draft = current.draft;
    if (!draft?.submitted || !authority) return "pending";
    // Even after a later fetch, first check the original idempotent authority
    // request: its previous reply may have been lost.
    const result = await authority.accept(scope, draft.operationId, draft.comparedRevision, draft.value);
    if (result.status === "changed") {
      const updated = await this.appendRemote(current, result.version);
      // Authority definitively rejected this selection, so the user may revise
      // it. Uncertain/failed calls do not unlock a possibly committed request.
      await this.store.writeConflict({ ...updated, generation: updated.generation + 1, draft: { ...draft, submitted: false } }, updated.generation);
      return "changed";
    }
    if (result.version.revision <= draft.comparedRevision || !sameValue(result.version.value, draft.value)) throw new Error("解决回执不完整，请核对原操作；材料保留。");
    if (result.version.revision === current.comparison.remote?.revision && !sameValue(result.version.value, current.comparison.remote.value)) throw new Error("统一位置回执与已取得进度不一致，材料保留。");
    if (result.version.revision < (current.comparison.remote?.revision ?? 0)) {
      await this.store.writeConflict({ ...current, generation: current.generation + 1, draft: { ...draft, submitted: false } }, current.generation);
      return "changed";
    }
    const local = await this.store.readRecord(scope);
    if (!local) throw new Error("原内容暂不可读，解决材料保留。");
    await this.store.finishConflict({ ...current, status: "resolved", generation: current.generation + 1,
      comparison: { ...current.comparison, remote: result.version }, remoteHistory: [...current.remoteHistory, result.version] }, current.generation, local.localSequence, draft.value);
    return "resolved";
  }
}
