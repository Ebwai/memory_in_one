// Single source for the desktop binary, manifest and update comparison.
export const DESKTOP_VERSION = "1.2.0";
export interface UpdateScreen {
  readonly currentVersion: string;
  readonly phase: "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "error";
  readonly canInstall: boolean;
  readonly version?: string;
  readonly notes?: string;
  readonly progress?: number;
  readonly message: string;
}
export type UpdateAction = "status" | "check" | "download" | "install";
