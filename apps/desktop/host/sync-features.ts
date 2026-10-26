import { validateExtensionRecord } from "@workspace/extension-sdk";
import type { DomainRegistration } from "@workspace/contracts";
import { ipcMain, powerMonitor } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { FileExtensionPrograms, HttpSyncRemote, SqliteLocalStore } from "@workspace/adapters";
import { SyncEngine } from "@workspace/core";
import { todoConflictPolicy, todoDefinition } from "@workspace/todo-list";
import { join } from "node:path";
import type { WorkspaceBinding } from "../bridge/workspace-contracts.js";
import type { SyncScreen } from "../bridge/workspace-contracts.js";

export function installSyncFeatures(check: (event: IpcMainInvokeEvent) => void, binding: () => WorkspaceBinding | null,
  remote: () => Promise<HttpSyncRemote>, base: () => string) {
  let stopped = false;
  let recovered = false;
  let active: Promise<SyncScreen> | null = null;
  let again = false;
  let state: SyncScreen = { phase: "pending", message: "本机已有内容可继续使用，尚未确认最新统一进度。", pending: 0, uncertain: 0, conflicts: 0, confirmed: 0, cursor: 0, lastSuccessAt: null };
  async function execute(): Promise<SyncScreen> {
    const current = binding();
    if (!current) return state;
    state = { ...state, phase: "syncing", message: "正在上传本机成果并取得统一进度…" };
    let store: SqliteLocalStore | undefined;
    try {
      store = await SqliteLocalStore.open({ databasePath: current.replicaPath });
      if (!recovered) { await store.recoverFrozen(current.workspace.workspaceId); recovered = true; }
      const registrations = await store.listRecords({ workspaceId: current.workspace.workspaceId, domainId: "system.domains" });
      const engine = new SyncEngine(current.workspace, store, await remote(), (domain) => domain === "builtin.todo" ? todoConflictPolicy : domain === "system.domains" ? {
        attributes: { enabled: ["enabled"] }, validate: () => undefined,
      } : (() => {
        const registration = registrations.find((entry) => entry.recordId === domain)?.payload as unknown as DomainRegistration | undefined;
        return registration ? { attributes: {}, validate: (value: import("@workspace/contracts").ContentValue) => { if (value !== null) validateExtensionRecord(registration.definition, value); } } : undefined;
      })());
      const errors = await engine.run();
      // This built-in program ships with the host. Acquiring registration never
      // installs or downloads a third-party extension on another device.
      await new FileExtensionPrograms(join(base(), "programs", current.workspace.workspaceId)).stage(todoDefinition);
      const summary = await store.syncSummary(current.workspace.workspaceId);
      state = { ...summary, phase: summary.conflicts ? "conflict" : summary.uncertain ? "unconfirmed" : errors.length ? "failed" : summary.pending ? "pending" : "synced",
        message: summary.conflicts ? "存在待处理冲突；其他独立内容可继续同步。" : errors.length ? errors[0]! : summary.pending ? "本机成果已保存，仍有改动待统一位置确认。" : "当前已保存改动已获统一位置确认，并已取得最新进度。",
        lastSuccessAt: new Date().toISOString() };
    } catch (error) {
      let summary = { pending: state.pending, uncertain: state.uncertain, conflicts: state.conflicts, confirmed: state.confirmed, cursor: state.cursor };
      try { if (store) summary = await store.syncSummary(current.workspace.workspaceId); } catch { /* Keep the last confirmed counters. */ }
      state = { ...summary, phase: "unconfirmed", message: error instanceof Error && /[\u4e00-\u9fff]/.test(error.message) ? error.message : "统一位置暂不可达或结果待确认；本机内容可用，原操作等待接续。", lastSuccessAt: state.lastSuccessAt };
    } finally { await store?.close().catch(() => undefined); }
    return state;
  }
  function trigger(saved = false): Promise<SyncScreen> {
    if (stopped || !binding()) return Promise.resolve(state);
    if (active) { if (saved) again = true; return active; }
    active = (async () => {
      let result = state;
      for (let pass = 0; pass < 3; ++pass) {
        again = false; result = await execute();
        if (!again || stopped) break;
      }
      return result;
    })().finally(() => { active = null; });
    return active;
  }
  ipcMain.handle("workspace:sync", async (event, action: unknown) => {
    check(event);
    if (action === "status") return state;
    if (action === "now") return trigger();
    throw new Error("无效同步动作。");
  });
  const tick = () => { void trigger(); };
  const timer = setInterval(tick, 10000); timer.unref();
  powerMonitor.on("resume", tick);
  return { trigger, stop: async () => { stopped = true; clearInterval(timer); powerMonitor.removeListener("resume", tick); await active; } };
}
