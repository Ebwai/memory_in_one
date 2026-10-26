import type { Comparison, ConflictPersistence, ConflictPolicy, LocalPersistence } from "@workspace/contracts";
import { compareContent } from "./merge.js";
import { ConflictService } from "./conflict-service.js";

// One shared decision path for upload and pull: conflict material must commit
// before a caller may advance its cursor or report the divergence as handled.
export class ConcurrentContent {
  constructor(private readonly store: ConflictPersistence & Pick<LocalPersistence, "readRecord">, private readonly policy?: ConflictPolicy) {}
  async evaluate(input: Comparison, sequence: number) {
    const decision = compareContent(input, this.policy);
    if (decision.status === "merged") return decision;
    return { status: "retained" as const, conflict: await new ConflictService(this.store, this.policy).retain(input, sequence) };
  }
}
