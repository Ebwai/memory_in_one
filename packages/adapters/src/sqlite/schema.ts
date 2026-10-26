export const APPLICATION_ID = 0x50575331;
export const SCHEMA_VERSION = 5;

export const CREATE_CONFLICT_SCHEMA = `
  CREATE TABLE retained_conflicts (
    workspace_id TEXT NOT NULL,
    domain_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation > 0),
    status TEXT NOT NULL CHECK(status IN ('pending', 'resolved')),
    material_json TEXT NOT NULL CHECK(json_valid(material_json)),
    PRIMARY KEY(workspace_id, domain_id, record_id)
  ) STRICT;
`;

export const CREATE_EDITOR_SCHEMA = `
  ALTER TABLE operation_delivery ADD COLUMN uncertain INTEGER NOT NULL DEFAULT 0 CHECK(uncertain IN (0,1));
  CREATE TABLE editor_drafts (
    workspace_id TEXT NOT NULL, domain_id TEXT NOT NULL, record_id TEXT NOT NULL, material_json TEXT NOT NULL CHECK(json_valid(material_json)),
    PRIMARY KEY(workspace_id,domain_id,record_id)
  ) STRICT;
`;

export const CREATE_REPLICATION_SCHEMA = `
  CREATE TABLE authority_versions (
    revision INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, domain_id TEXT NOT NULL, record_id TEXT NOT NULL,
    value_json TEXT NOT NULL CHECK(json_valid(value_json)), changed_json TEXT NOT NULL CHECK(json_valid(changed_json))
  ) STRICT;
  CREATE INDEX authority_record ON authority_versions(workspace_id,domain_id,record_id,revision);
  CREATE TABLE authority_receipts (
    workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    result_json TEXT NOT NULL CHECK(json_valid(result_json)), PRIMARY KEY(workspace_id,operation_id)
  ) STRICT;
  CREATE TABLE replica_progress (
    workspace_id TEXT NOT NULL, domain_id TEXT NOT NULL, record_id TEXT NOT NULL, version_json TEXT NOT NULL CHECK(json_valid(version_json)),
    PRIMARY KEY(workspace_id,domain_id,record_id)
  ) STRICT;
  CREATE TABLE operation_delivery (
    sequence INTEGER PRIMARY KEY REFERENCES pending_operations(sequence), base_json TEXT NOT NULL CHECK(json_valid(base_json)),
    before_json TEXT NOT NULL CHECK(json_valid(before_json)), parent_sequence INTEGER,
    request_json TEXT, state TEXT NOT NULL CHECK(state IN ('pending','acked','imported','superseded')),
    result_json TEXT, message TEXT NOT NULL DEFAULT ''
  ) STRICT;
  CREATE TABLE replica_cursors (workspace_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL CHECK(cursor >= 0)) STRICT;
`;

export const CREATE_MCP_SCHEMA = `
  CREATE TABLE mcp_host_programs (workspace_id TEXT NOT NULL, domain_id TEXT NOT NULL, available INTEGER NOT NULL CHECK(available IN (0,1)), PRIMARY KEY(workspace_id,domain_id)) STRICT;
  CREATE TABLE mcp_requests (workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL, prepared_json TEXT NOT NULL CHECK(json_valid(prepared_json)), PRIMARY KEY(workspace_id,operation_id)) STRICT;
  CREATE TABLE mcp_grants (workspace_id TEXT NOT NULL, id TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE,
    grant_json TEXT NOT NULL CHECK(json_valid(grant_json)), PRIMARY KEY(workspace_id,id)) STRICT;
  CREATE TABLE mcp_calls (workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL, source_id TEXT NOT NULL,
    call_json TEXT NOT NULL CHECK(json_valid(call_json)), PRIMARY KEY(workspace_id,operation_id)) STRICT;
`;

export const CREATE_SCHEMA = CREATE_MCP_SCHEMA + CREATE_CONFLICT_SCHEMA + CREATE_REPLICATION_SCHEMA + CREATE_EDITOR_SCHEMA + `
  CREATE TABLE pending_operations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL CHECK(length(trim(workspace_id)) > 0),
    domain_id TEXT NOT NULL CHECK(length(trim(domain_id)) > 0),
    record_id TEXT NOT NULL CHECK(length(trim(record_id)) > 0),
    operation_id TEXT NOT NULL CHECK(length(trim(operation_id)) > 0),
    kind TEXT NOT NULL CHECK(kind IN ('put', 'delete')),
    payload_json TEXT,
    UNIQUE(workspace_id, operation_id),
    CHECK((kind = 'delete' AND payload_json IS NULL) OR
      (kind = 'put' AND payload_json IS NOT NULL AND json_valid(payload_json) AND json_type(payload_json) = 'object'))
  ) STRICT;
  CREATE INDEX pending_by_domain ON pending_operations(workspace_id, domain_id, sequence);
  CREATE TABLE local_records (
    workspace_id TEXT NOT NULL,
    domain_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    deleted INTEGER NOT NULL CHECK(deleted IN (0, 1)),
    payload_json TEXT,
    last_sequence INTEGER NOT NULL REFERENCES pending_operations(sequence),
    PRIMARY KEY(workspace_id, domain_id, record_id),
    CHECK((deleted = 1 AND payload_json IS NULL) OR
      (deleted = 0 AND payload_json IS NOT NULL AND json_valid(payload_json) AND json_type(payload_json) = 'object'))
  ) STRICT;
`;

