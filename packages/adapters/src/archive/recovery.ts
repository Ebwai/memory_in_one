import { Worker } from "node:worker_threads";
import type { WorkspaceIdentity } from "@workspace/contracts";
import type { WorkspaceArchive } from "./workspace-archive.js";

export interface RecoverySummary {
  readonly workspace: WorkspaceIdentity;
  readonly source: "local" | "authority";
  readonly capturedAt: string;
  readonly location: string;
  readonly target: string;
  readonly databasePath: string;
  readonly domains: readonly { readonly domainId: string; readonly name: string; readonly available: boolean }[];
  readonly pending: number;
  readonly uncertain: number;
  readonly conflicts: number;
  readonly fingerprint: string;
  readonly state: "local" | "prepared";
  readonly alreadyRestored?: boolean;
}

export async function recoverArchive(archive: WorkspaceArchive, target: string, confirmed = false, programFingerprints: Readonly<Record<string, string>> = {}): Promise<RecoverySummary> {
  const worker = new Worker(new URL("./recovery-worker.js", import.meta.url), { workerData: { method: confirmed ? "restore" : "preview", archive, target, programFingerprints } });
  try {
    return await new Promise<RecoverySummary>((resolve, reject) => {
      worker.once("message", (message: { ok: boolean; value: RecoverySummary; message: string }) => message.ok ? resolve(message.value) : reject(new Error(message.message)));
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error("恢复执行中断，请核对原目标。")));
    });
  } finally { await worker.terminate(); }
}
