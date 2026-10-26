import type { DatabaseSync } from "node:sqlite";
import { canonical, LocalStoreError, type McpCall, type McpGrant, type McpPrepared, type McpStorageCommand } from "@workspace/contracts";

import { requireAuthorityWrite } from "./authority-lifecycle.js";

export class McpDatabase {
  constructor(private readonly db: DatabaseSync) {}
  save(call: McpCall): McpCall {
    const previous = this.read(call.workspaceId, call.operationId);
    if (previous) {
      if (["sourceId", "domainId", "action", "recordId"].some(key => previous[key as keyof McpCall] !== call[key as keyof McpCall])) throw new LocalStoreError("operation-mismatch");
      if (["succeeded", "failed", "conflict", "cancelled"].includes(previous.status)) {
        if (canonical(previous) !== canonical(call)) throw new LocalStoreError("operation-mismatch");
        return previous;
      }
    }
    this.db.prepare("INSERT INTO mcp_calls VALUES(?,?,?,?) ON CONFLICT(workspace_id,operation_id) DO UPDATE SET call_json=excluded.call_json")
      .run(call.workspaceId, call.operationId, call.sourceId, JSON.stringify(call));
    return call;
  }
  read(workspaceId: string, operationId: string): McpCall | null {
    const row = this.db.prepare("SELECT call_json FROM mcp_calls WHERE workspace_id=? AND operation_id=?").get(workspaceId, operationId);
    return row ? JSON.parse(String(row.call_json)) as McpCall : null;
  }
assertAllowed(call: McpCall): void {
    const row = this.db.prepare("SELECT grant_json FROM mcp_grants WHERE workspace_id=? AND id=?").get(call.workspaceId, call.sourceId);
    const grant = row ? JSON.parse(String(row.grant_json)) as McpGrant : null;
    const host = this.db.prepare("SELECT available FROM mcp_host_programs WHERE workspace_id=? AND domain_id=?").get(call.workspaceId, call.domainId);
    if (host?.available === 0 && ["read", "create", "update", "date", "complete", "restore", "delete", "enable"].includes(call.action)) throw new LocalStoreError("operation-mismatch");
    if (!grant || grant.revoked || !grant.domains.includes(call.domainId) || !grant.actions.includes(call.action)) throw new LocalStoreError("operation-mismatch");
  }
  private transaction(work: () => unknown): unknown {
    this.db.exec("BEGIN IMMEDIATE");
    try { requireAuthorityWrite(this.db); const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

prepared(workspaceId: string, operationId: string): McpPrepared | null {
    const row = this.db.prepare("SELECT prepared_json FROM mcp_requests WHERE workspace_id=? AND operation_id=?").get(workspaceId, operationId);
    return row ? JSON.parse(String(row.prepared_json)) as McpPrepared : null;
  }

  execute(command: McpStorageCommand): unknown {
    if (command.method === "host-get") {
      const row = this.db.prepare("SELECT available FROM mcp_host_programs WHERE workspace_id=? AND domain_id=?").get(command.workspaceId, command.domainId);
      return row ? Boolean(row.available) : true;
    }
    if (command.method === "host-set") return this.transaction(() => {
      this.assertAllowed(command.audit);
      const prior = this.read(command.workspaceId, command.audit.operationId);
      if (prior) {
        if (prior.domainId !== command.domainId || prior.action !== command.audit.action || prior.sourceId !== command.audit.sourceId) throw new LocalStoreError("operation-mismatch");
        return prior;
      }
      this.db.prepare("INSERT INTO mcp_host_programs VALUES(?,?,?) ON CONFLICT(workspace_id,domain_id) DO UPDATE SET available=excluded.available").run(command.workspaceId, command.domainId, command.available ? 1 : 0);
      return this.save(command.audit);
    });
    if (command.method === "prepared") return this.prepared(command.workspaceId, command.operationId);
    if (command.method === "prepare") return this.transaction(() => {
      const p = command.prepared;
      const prior = this.prepared(p.request.workspaceId, p.request.operationId);
      if (prior) { if (prior.key !== p.key) throw new LocalStoreError("operation-mismatch"); return prior; }
      this.assertAllowed(p.request.audit!);
      this.db.prepare("INSERT INTO mcp_requests VALUES(?,?,?)").run(p.request.workspaceId, p.request.operationId, JSON.stringify(p));
      this.save(p.request.audit!); return p;
    });
    if (command.method === "confirm") return this.transaction(() => {
      const p = this.prepared(command.workspaceId, command.operationId);
      if (!p || p.challenge !== command.challenge || p.confirmation !== "pending") throw new LocalStoreError("operation-mismatch");
      this.assertAllowed(p.request.audit!);
      const current = this.db.prepare("SELECT MAX(revision) AS revision FROM authority_versions WHERE workspace_id=? AND domain_id=? AND record_id=?")
        .get(p.request.workspaceId, p.request.domainId, p.request.recordId);
      if (Number(current?.revision ?? 0) !== p.request.baseRevision) throw new LocalStoreError("operation-mismatch");
      const next = { ...p, confirmation: command.accepted ? "accepted" : "declined", request: { ...p.request, audit: { ...p.request.audit!, confirmed: command.accepted } } };
      this.db.prepare("UPDATE mcp_requests SET prepared_json=? WHERE workspace_id=? AND operation_id=?").run(JSON.stringify(next), command.workspaceId, command.operationId);
      if (!command.accepted) this.save({ ...p.request.audit!, status: "cancelled", result: { status: "cancelled" } });
      return next;
    });
    if (command.method === "grant-create") return this.transaction(() => {
      this.db.prepare("INSERT INTO mcp_grants VALUES(?,?,?,?)").run(command.grant.workspaceId, command.grant.id, command.secretHash, JSON.stringify(command.grant));
      this.save(command.audit); return command.grant;
    });
    if (command.method === "grant-list") return this.db.prepare("SELECT grant_json FROM mcp_grants WHERE workspace_id=?").all(command.workspaceId).map(row => JSON.parse(String(row.grant_json)));
    if (command.method === "grant-auth") {
      const row = this.db.prepare("SELECT grant_json FROM mcp_grants WHERE workspace_id=? AND secret_hash=?").get(command.workspaceId, command.secretHash);
      const grant = row ? JSON.parse(String(row.grant_json)) as McpGrant : null;
      return grant && !grant.revoked ? grant : null;
    }
    if (command.method === "grant-revoke") return this.transaction(() => {
      const row = this.db.prepare("SELECT grant_json FROM mcp_grants WHERE workspace_id=? AND id=?").get(command.workspaceId, command.id);
      if (!row) throw new LocalStoreError("operation-mismatch");
      const grant = { ...JSON.parse(String(row.grant_json)) as McpGrant, revoked: true };
      this.db.prepare("UPDATE mcp_grants SET grant_json=? WHERE workspace_id=? AND id=?").run(JSON.stringify(grant), command.workspaceId, command.id);
      if (!this.read(command.workspaceId, command.audit.operationId)) this.save(command.audit);
      return grant;
    });
    if (command.method === "call-save") return this.transaction(() => this.save(command.call));
    if (command.method === "call-read") return this.read(command.workspaceId, command.operationId);
    return this.db.prepare("SELECT call_json FROM mcp_calls WHERE workspace_id=? AND (? IS NULL OR source_id=?) ORDER BY rowid DESC")
      .all(command.workspaceId, command.sourceId ?? null, command.sourceId ?? null).map(row => JSON.parse(String(row.call_json)) as McpCall);
  }
}
