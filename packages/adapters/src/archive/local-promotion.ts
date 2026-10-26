import { canonical, type AuthorityVersion, type JsonObject } from "@workspace/contracts";
import type { WorkspaceArchive } from "./workspace-archive.js";

/** Local recovery keeps unconfirmed operations in its original replica. Only
 * confirmed versions become authority facts; pending actions are never replayed here. */
export function authorityFromLocal(archive: WorkspaceArchive): WorkspaceArchive {
  if (archive.snapshot.source !== "local") throw new Error("请选择本机来源材料。");
  const tables = archive.snapshot.tables;
  const versions = new Map<number, AuthorityVersion>();
  const add = (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const v = raw as AuthorityVersion;
    if (v.workspaceId !== archive.workspace.workspaceId || !Number.isSafeInteger(v.revision) || v.revision <= 0 || !v.domainId || !v.recordId || !Array.isArray(v.changed)) throw new Error("本机确认进度不完整。");
    const old = versions.get(v.revision);
    if (old && (old.workspaceId !== v.workspaceId || old.domainId !== v.domainId || old.recordId !== v.recordId || canonical(old.value) !== canonical(v.value))) throw new Error("本机材料存在矛盾的统一进度。");
    if (!old) versions.set(v.revision, v);
  };
  for (const row of tables.replica_progress ?? []) add(JSON.parse(String(row.version_json)));
  for (const row of tables.operation_delivery ?? []) {
    add(JSON.parse(String(row.base_json)));
    if (row.result_json) add(JSON.parse(String(row.result_json)));
  }
  // Conflict remote state/history is needed before resubmitting the original local
  // action. Retained material itself stays available in both recovery copies.
  for (const row of tables.retained_conflicts ?? []) {
    const material = JSON.parse(String(row.material_json)) as { comparison: { workspaceId: string; domainId: string; recordId: string; remote: { revision: number; value: JsonObject | null }; remoteChanged: string[] }; remoteHistory: { revision: number; value: JsonObject | null }[] };
    const c = material.comparison;
    for (const version of material.remoteHistory ?? []) add({ workspaceId: c.workspaceId, domainId: c.domainId, recordId: c.recordId, revision: version.revision, value: version.value, changed: c.remoteChanged ?? [] });
    if (c?.remote?.revision > 0) add({ workspaceId: c.workspaceId, domainId: c.domainId, recordId: c.recordId, revision: c.remote.revision, value: c.remote.value, changed: c.remoteChanged ?? [] });
  }
  const authority_versions = [...versions.values()].sort((a, b) => a.revision - b.revision).map(v => ({ revision: v.revision, workspace_id: v.workspaceId, domain_id: v.domainId, record_id: v.recordId, value_json: JSON.stringify(v.value), changed_json: JSON.stringify(v.changed) }));
  const authority_receipts: JsonObject[] = [];
  const operations = new Map((tables.pending_operations ?? []).map(row => [row.sequence, row]));
  for (const row of tables.operation_delivery ?? []) {
    const operation = operations.get(row.sequence);
    if (row.state === "acked" && row.request_json && row.result_json && operation) authority_receipts.push({ workspace_id: archive.workspace.workspaceId, operation_id: operation.operation_id!, request_json: String(row.request_json), result_json: JSON.stringify({ status: "accepted", version: JSON.parse(String(row.result_json)) }) });
  }
  return { ...archive, snapshot: { ...archive.snapshot, source: "authority", authorityState: "prepared", tables: { authority_versions, authority_receipts, retained_conflicts: tables.retained_conflicts!, mcp_requests: tables.mcp_requests!, mcp_calls: tables.mcp_calls!, grant_definitions: tables.grant_definitions! } } };
}
