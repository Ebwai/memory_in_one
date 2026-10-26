import type { Comparison, ConflictPolicy, JsonObject, JsonValue, MergeDecision } from "@workspace/contracts";

export function sameValue(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) =>
    Object.hasOwn(right, key) && sameValue((left as JsonObject)[key], (right as JsonObject)[key]));
}

export function compareContent(input: Comparison, policy?: ConflictPolicy): MergeDecision {
  const conflict = (...reasons: string[]): MergeDecision => ({ status: "conflict", reasons });
  const { base, local, remote } = input;
  if (!base || !remote || !Number.isSafeInteger(base.revision) || base.revision < 1 || !Number.isSafeInteger(remote.revision) || base.revision !== local.baseRevision || remote.revision < base.revision) return conflict("missing-common-progress");
  if (!policy) return conflict("domain-policy-unavailable");
  try {
    policy.validate(base.value, base.value);
    policy.validate(local.value, base.value);
    policy.validate(remote.value, base.value);
    if (remote.revision === base.revision && !sameValue(remote.value, base.value)) return conflict("inconsistent-progress");
    if (local.value === null && remote.value === null) return { status: "merged", value: null };
    if (local.value === null || remote.value === null) {
      const survivor = local.value === null ? remote.value : local.value;
      const changes = local.value === null ? input.remoteChanged : local.changed;
      if (changes.length || !sameValue(survivor, base.value)) return conflict("delete-edit");
      return { status: "merged", value: null };
    }
    if (!base.value) return conflict("missing-live-base");
    if ([...local.changed, ...input.remoteChanged].some((attribute) => !Object.hasOwn(policy.attributes, attribute))) return conflict("undeclared-change");
    const result: JsonObject = { ...remote.value };
    const reasons: string[] = [];
    const covered = Object.values(policy.attributes).flat();
    const fields = new Set([...Object.keys(base.value), ...Object.keys(local.value), ...Object.keys(remote.value)]);
    for (const key of fields) if (!covered.includes(key) &&
      (!sameValue(local.value[key], base.value[key]) || !sameValue(remote.value[key], base.value[key]))) reasons.push("undeclared:" + key);
    for (const [attribute, keys] of Object.entries(policy.attributes)) {
      const localChanged = local.changed.includes(attribute) || keys.some((key) => !sameValue(local.value![key], base.value![key]));
      const remoteChanged = input.remoteChanged.includes(attribute) || keys.some((key) => !sameValue(remote.value![key], base.value![key]));
      if (localChanged && remoteChanged) {
        if (!keys.every((key) => sameValue(local.value![key], remote.value![key])) && !policy.compatible?.(attribute, local.value, remote.value)) reasons.push(attribute);
      } else if (localChanged) {
        for (const key of keys) {
          if (Object.hasOwn(local.value, key)) result[key] = local.value[key]!;
          else delete result[key];
        }
      }
    }
    if (reasons.length) return conflict(...reasons);
    policy.validate(result, base.value);
    return { status: "merged", value: result };
  } catch { return conflict("invalid-domain-result"); }
}
