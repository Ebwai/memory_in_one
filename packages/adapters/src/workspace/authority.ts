import { Worker } from "node:worker_threads";
import type { WorkspaceCreateResult, WorkspaceCreationPort, WorkspaceIdentity, WorkspaceProposal } from "@workspace/contracts";

export class SqliteWorkspaceAuthority implements WorkspaceCreationPort {
  constructor(private readonly directory: string) {}
  private async execute(method: "create" | "inspect", proposal?: WorkspaceProposal): Promise<WorkspaceCreateResult | WorkspaceIdentity | null> {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { workerData: { directory: this.directory, method, proposal } });
    try {
      return await new Promise((resolve, reject) => {
        worker.once("message", (message: { ok: boolean; value: WorkspaceCreateResult | WorkspaceIdentity | null }) =>
          message.ok ? resolve(message.value) : reject(new Error("Workspace storage unavailable")));
        worker.once("error", reject);
        worker.once("exit", () => reject(new Error("Workspace storage stopped")));
      });
    } finally { await worker.terminate(); }
  }
  async create(proposal: WorkspaceProposal): Promise<WorkspaceCreateResult> {
    return await this.execute("create", proposal) as WorkspaceCreateResult;
  }
  async inspect(): Promise<WorkspaceIdentity | null> {
    return await this.execute("inspect") as WorkspaceIdentity | null;
  }
}

