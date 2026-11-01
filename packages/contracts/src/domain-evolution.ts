import type { ExtensionDefinition, JsonObject } from "./index.js";
import { canonical } from "./replication.js";

/** Only additive optional scalar fields are safe without rewriting existing records. */
export function isCompatibleDomainUpgrade(old: ExtensionDefinition, next: ExtensionDefinition): boolean {
  if (old.domainId !== next.domainId || old.format !== next.format || old.hostApi !== next.hostApi || old.dataVersion !== next.dataVersion || old.access !== next.access) return false;
  const version = (v: string) => v.split(".").map(Number);
  const a = version(old.version), b = version(next.version);
  const differing = a.findIndex((v, i) => v !== b[i]);
  if (differing < 0 || !(b[differing]! > a[differing]!)) return false;
  if (canonical(old.schema.required) !== canonical(next.schema.required) || old.schema.additionalProperties !== next.schema.additionalProperties || old.schema.type !== next.schema.type) return false;
  const before = old.schema.properties as JsonObject, after = next.schema.properties as JsonObject;
  if (!before || !after || Object.keys(before).some(key => canonical(before[key]) !== canonical(after[key]))) return false;
  return old.actions.every(action => next.actions.includes(action));
}
