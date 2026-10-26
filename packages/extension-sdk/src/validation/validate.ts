import type { ExtensionDefinition, JsonObject } from "@workspace/contracts";

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("扩展包含不支持的声明或权限。");
}
const fieldName = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/** Version 1 accepts a closed, scalar object subset of JSON Schema 2020-12. No references or scripts. */
export function parseExtension(source: string): ExtensionDefinition {
  if (source.length > 262144) throw new Error("扩展声明过长，请提供不超过 262144 个字符的声明。");
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { throw new Error("扩展不是有效的 JSON 文件。"); }
  if (!object(raw)) throw new Error("扩展清单格式无效。");
  keys(raw, ["format", "domainId", "name", "version", "hostApi", "dataVersion", "access", "schema", "view", "actions"]);
  if (raw.format !== 1 || raw.hostApi !== 1 || raw.dataVersion !== 1 || raw.access !== "own-domain") throw new Error("扩展版本或访问范围不兼容；仅支持所属领域访问。");
  if (typeof raw.domainId !== "string" || !/^[a-z][a-z0-9.-]{2,127}$/.test(raw.domainId) || (raw.domainId.startsWith("system.") || raw.domainId.startsWith("builtin."))) throw new Error("领域稳定身份无效或使用了保留身份。");
  if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 100 || typeof raw.version !== "string" || !/^\d+\.\d+\.\d+$/.test(raw.version)) throw new Error("请提供有效名称和版本。");
  const schema = raw.schema;
  if (!object(schema)) throw new Error("缺少数据格式声明。");
  keys(schema, ["$schema", "type", "properties", "required", "additionalProperties"]);
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema" || schema.type !== "object" || schema.additionalProperties !== false || !object(schema.properties)) throw new Error("数据格式必须使用受限 JSON Schema 2020-12 对象声明。");
  const fields = Object.keys(schema.properties);
  if (!fields.length || fields.length > 64 || fields.some((name) => !fieldName.test(name) || ["constructor", "prototype", "__proto__"].includes(name))) throw new Error("字段名称或数量无效。");
  for (const rule of Object.values(schema.properties)) {
    if (!object(rule)) throw new Error("字段格式声明无效。");
    keys(rule, ["type", "enum", "maxLength"]);
    if (!["string", "number", "boolean"].includes(String(rule.type))) throw new Error("当前仅支持文本、数字及布尔字段。");
    if (rule.maxLength !== undefined && (rule.type !== "string" || !Number.isSafeInteger(rule.maxLength) || Number(rule.maxLength) < 1 || Number(rule.maxLength) > 100000)) throw new Error("文本长度声明无效。");
    if (rule.enum !== undefined && (!Array.isArray(rule.enum) || !rule.enum.length || rule.enum.some((item) => typeof item !== rule.type))) throw new Error("字段枚举声明无效。");
  }
  if (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string" || !fields.includes(key))) throw new Error("必填字段引用无效。");
  if (!object(raw.view)) throw new Error("视图声明无效。");
  keys(raw.view, ["titleField", "fields"]);
  if (typeof raw.view.titleField !== "string" || !fields.includes(raw.view.titleField) || !Array.isArray(raw.view.fields) || !raw.view.fields.length || raw.view.fields.some((key) => typeof key !== "string" || !fields.includes(key))) throw new Error("视图字段引用无效。");
  if (!Array.isArray(raw.actions) || !raw.actions.length || raw.actions.some((action) => !["create", "update", "delete"].includes(String(action)))) throw new Error("扩展动作声明无效。");
  // Canonical key order makes formatting-only re-registration use the same program identity on every host.
  return JSON.parse(JSON.stringify({ ...raw, name: raw.name.trim() }, (_key, value: unknown) =>
    object(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value)) as ExtensionDefinition;
}

export function validateExtensionRecord(definition: ExtensionDefinition, payload: JsonObject): void {
  const properties = definition.schema.properties as JsonObject;
  const required = definition.schema.required as string[];
  if (Object.keys(payload).some((key) => !Object.hasOwn(properties, key)) || required.some((key) => !Object.hasOwn(payload, key))) throw new Error("内容包含未知字段或缺少必填字段。");
  for (const [key, value] of Object.entries(payload)) {
    const rule = properties[key] as JsonObject;
    if (!rule || typeof value !== rule.type || (typeof value === "number" && !Number.isFinite(value)) ||
      (typeof value === "string" && rule.maxLength !== undefined && value.length > Number(rule.maxLength)) ||
      (Array.isArray(rule.enum) && !rule.enum.includes(value))) throw new Error("字段内容与扩展数据格式不符：" + key);
  }
}
