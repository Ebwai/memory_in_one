import { canonical, type DomainRegistration, type ExtensionDefinition } from "@workspace/contracts";

export function prepareDomainRegistration(old: DomainRegistration | null, definition: ExtensionDefinition, fingerprint: string): DomainRegistration {
  if (old && canonical(old.definition) !== canonical(definition)) throw new Error("该领域身份已有不同程序或版本，不能通过重复注册覆盖原登记和数据。");
  return old ?? { definition, fingerprint, enabled: false };
}
export function prepareDomainEnabled(old: DomainRegistration, enabled: boolean, programAvailable: boolean): DomainRegistration {
  if (enabled && !programAvailable) throw new Error("本机缺少兼容程序，请先补齐；未改变空间启用状态。");
  return { ...old, enabled };
}
