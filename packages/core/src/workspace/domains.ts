import { prepareDomainRegistration, prepareDomainEnabled } from "./domain-changes.js";
import type { DomainEntry, DomainRegistration, ExtensionDefinition, ExtensionPrograms, LocalPersistence } from "@workspace/contracts";

export const DOMAIN_REGISTRY = "system.domains";
export class DomainRegistry {
  constructor(private readonly workspaceId: string, private readonly store: LocalPersistence, private readonly programs: ExtensionPrograms, private readonly canRemoveProgram: (definition: ExtensionDefinition) => boolean = () => true) {}
  async list(): Promise<readonly DomainEntry[]> {
    const records = await this.store.listRecords({ workspaceId: this.workspaceId, domainId: DOMAIN_REGISTRY });
    return Promise.all(records.filter((record) => !record.deleted).map(async (record) => {
      const registration = record.payload as unknown as DomainRegistration;
      return { ...registration, programAvailable: await this.programs.available(registration.fingerprint) };
    }));
  }
  async register(definition: ExtensionDefinition, operationId: string): Promise<"registered" | "already-registered" | "program-restored"> {
    const scope = { workspaceId: this.workspaceId, domainId: DOMAIN_REGISTRY, recordId: definition.domainId };
    const existing = await this.store.readRecord(scope);
    const old = existing?.payload as unknown as DomainRegistration | undefined;
    // Exact package equality is deliberate: registration is not an upgrade or a data migration.
    prepareDomainRegistration(old ?? null, definition, "");
    const wasAvailable = old ? await this.programs.available(old.fingerprint) : false;
    const fingerprint = await this.programs.stage(definition);
    if (old) return wasAvailable ? "already-registered" : "program-restored";
    const registration: DomainRegistration = { definition, fingerprint, enabled: false };
    await this.store.commit({ ...scope, operationId, kind: "put", payloadJson: JSON.stringify(registration) }, null);
    return "registered";
  }
  async get(domainId: string): Promise<DomainEntry> {
    const entry = (await this.list()).find((item) => item.definition.domainId === domainId);
    if (!entry) throw new Error("该领域尚未登记。");
    return entry;
  }

  async contentStore(domainId: string): Promise<LocalPersistence> {
    const entry = await this.get(domainId);
    if (!entry.enabled || !entry.programAvailable) throw new Error("领域已停用或缺少兼容程序，原数据与输入保留。");
    const scope = { workspaceId: this.workspaceId, domainId: DOMAIN_REGISTRY, recordId: domainId };
    const registration = await this.store.readRecord(scope);
    if (!registration || !(registration.payload as unknown as DomainRegistration).enabled) throw new Error("领域已停用，原数据与输入保留。");
    const guard = { scope, localSequence: registration.localSequence };
    const check = (input: { workspaceId: string; domainId: string }) => {
      if (input.workspaceId !== this.workspaceId || input.domainId !== domainId) throw new Error("领域程序无权访问其他领域。");
    };
    return {
      commit: async (change, expectedSequence) => { check(change); return this.store.commit(change, expectedSequence, guard); },
      ...(this.store.commitBatch ? { commitBatch: async (changes: readonly import("@workspace/contracts").PreparedChange[], basis: readonly import("@workspace/contracts").LocalRecord[]) => { changes.forEach(check); basis.forEach(check); return this.store.commitBatch!(changes, basis, guard); } } : {}),
      readRecord: async (input) => { check(input); return this.store.readRecord(input); },
      readOperation: async (input) => { check(input); return this.store.readOperation(input); },
      listRecords: async (input) => { check(input); return this.store.listRecords(input); },
      listPending: async (input) => { check(input); return this.store.listPending(input); },
      close: async () => undefined,
    };
  }

  async removeProgram(domainId: string): Promise<void> {
    const entry = await this.get(domainId);
    if (!this.canRemoveProgram(entry.definition)) throw new Error("此内置程序不能独立移除，可选择停用。");
    await this.programs.remove(entry.fingerprint);
  }

  async setEnabled(domainId: string, enabled: boolean, operationId: string): Promise<void> {
    const entry = await this.get(domainId);
    if (enabled && !entry.programAvailable) throw new Error("本机缺少兼容程序，请先补齐；未改变空间启用状态。");
    const scope = { workspaceId: this.workspaceId, domainId: DOMAIN_REGISTRY, recordId: domainId };
    const record = await this.store.readRecord(scope);
    if (!record?.payload) throw new Error("领域登记不可用。");
    const old = record.payload as unknown as DomainRegistration;
    const next = prepareDomainEnabled(old, enabled, entry.programAvailable);
    await this.store.commit({ ...scope, operationId, kind: "put", payloadJson: JSON.stringify(next) }, record.localSequence);
  }
}
