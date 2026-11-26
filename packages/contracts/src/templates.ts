import type { ExtensionDefinition, JsonObject } from "./index.js";
import { canonical } from "./replication.js";

export const NOTES_DOMAIN = "preset.notes";
export const PROJECT_PREFIX = "preset.project.";
export function isProjectDomain(id: string): boolean { return /^preset\.(?:project|checklist)\.[a-z0-9-]{1,80}$/.test(id); }
export function isPresetDomain(id: string): boolean { return id === NOTES_DOMAIN || isProjectDomain(id); }
/** Templates are shipped programs; instance identity never depends on its display name. */
export function presetDefinition(domainId: string, legacyNotes = false): ExtensionDefinition {
  if (!isPresetDomain(domainId)) throw new Error("未知的预设模板身份。");
  const project = isProjectDomain(domainId);
  return {
    format: 1, domainId, name: domainId.startsWith("preset.checklist.") ? "清单" : project ? "项目" : "随记", version: !project && !legacyNotes ? "1.1.0" : "1.0.0", hostApi: 1, dataVersion: 1, access: "own-domain",
    schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
      properties: { text: { type: "string", maxLength: 100000 }, createdAt: { type: "string" },
        ...(!project && !legacyNotes ? { title: { type: "string", maxLength: 100000 } } : {}),
        ...(project ? { kind: { type: "string", enum: domainId.startsWith("preset.checklist.") ? ["task"] : ["idea", "task"] }, completed: { type: "boolean" } } : {}) },
      required: project ? ["text", "createdAt", "kind", "completed"] : ["text", "createdAt"] },
    view: { titleField: "text", fields: project ? ["text", "kind", "completed"] : ["text"] }, actions: ["create", "update", "delete"],
  };
}
export function matchesPreset(definition: ExtensionDefinition): boolean {
  return isPresetDomain(definition.domainId) && (canonical(definition) === canonical(presetDefinition(definition.domainId)) || definition.domainId === NOTES_DOMAIN && canonical(definition) === canonical(presetDefinition(definition.domainId, true)));
}
export function noteTitle(value: JsonObject | null): string {
  if (typeof value?.title === "string" && value.title.trim()) return value.title.trim();
  return Array.from(String(value?.text ?? "")).slice(0, 15).join("");
}
export function validatePresetRecord(domainId: string, value: JsonObject): void {
  if (typeof value.text !== "string" || !value.text.trim() || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) throw new Error("请填写内容并保留有效创建时间。");
  if (domainId === NOTES_DOMAIN && value.title !== undefined && typeof value.title !== "string") throw new Error("随记标题必须是文本。");
  if (isProjectDomain(domainId) && (value.kind !== "idea" && value.kind !== "task" || typeof value.completed !== "boolean" || value.kind === "idea" && value.completed)) throw new Error("项目内容类型或完成状态无效。");
}
