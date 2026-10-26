import type { LocalRecord, LocalSaveResult, PendingOperation } from "@workspace/contracts";

export interface DemoSaveInput { readonly operationId: string; readonly text: string }
export type DemoLoadResult =
  | { readonly ok: true; readonly record: LocalRecord | null; readonly receipt: PendingOperation | null }
  | { readonly ok: false; readonly message: string };
export interface StatusDemoBridge {
  save(input: DemoSaveInput): Promise<LocalSaveResult>;
  recover(operationId: string): Promise<LocalSaveResult>;
  load(): Promise<DemoLoadResult>;
}

