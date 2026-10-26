import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, link, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { WorkspaceIdentity, WorkspaceSnapshot } from "@workspace/contracts";

export interface WorkspaceArchive {
  readonly workspace: WorkspaceIdentity;
  readonly location: string;
  readonly snapshot: WorkspaceSnapshot;
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function encodeArchive(archive: WorkspaceArchive): string {
  if (archive.workspace.workspaceId !== archive.snapshot.workspaceId) throw new Error("空间身份不匹配。");
  const payload = JSON.stringify(archive);
  return JSON.stringify({ format: "personal-workspace-archive", version: 1, algorithm: "sha256", checksum: digest(payload), payload });
}

export function decodeArchive(text: string): WorkspaceArchive {
  const envelope = JSON.parse(text) as Record<string, unknown>;
  if (envelope.format !== "personal-workspace-archive" || envelope.version !== 1 || envelope.algorithm !== "sha256" || typeof envelope.payload !== "string" || envelope.checksum !== digest(envelope.payload)) throw new Error("文件不完整、已损坏或格式不兼容。");
  const archive = JSON.parse(envelope.payload) as WorkspaceArchive;
  if (!archive?.workspace?.workspaceId || !archive.workspace.authorityId || !archive.workspace.name || !archive.workspace.creationId || !archive.workspace.createdAt || typeof archive.location !== "string" || archive.snapshot?.format !== "workspace-snapshot" || archive.snapshot.version !== 1 || archive.snapshot.workspaceId !== archive.workspace.workspaceId || !["authority", "local"].includes(archive.snapshot.source) || !Number.isFinite(Date.parse(archive.snapshot.capturedAt)) || !archive.snapshot.tables || typeof archive.snapshot.tables !== "object") throw new Error("导出材料身份或范围无效。");
  return archive;
}

export async function readArchive(path: string): Promise<WorkspaceArchive> {
  try { return decodeArchive(await readFile(path, "utf8")); }
  catch { throw new Error("无法读取完整恢复文件，请核对位置、格式和完整性。"); }
}

/** Publish only a flushed, reread and verified complete file; failures preserve the old target. */
export async function deliverArchive(path: string, archive: WorkspaceArchive, replace = false): Promise<void> {
  const target = resolve(path), temporary = target + "." + randomUUID() + ".partial";
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(encodeArchive(archive), "utf8"); await file.sync(); } finally { await file.close(); }
    const checked = await readArchive(temporary);
    if (JSON.stringify(checked) !== JSON.stringify(archive)) throw new Error("文件校验失败。");
    if (replace) await rename(temporary, target);
    else { await link(temporary, target); await unlink(temporary); }
  } finally { await unlink(temporary).catch(() => {}); }
}
