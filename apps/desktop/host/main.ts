import { app, BrowserWindow, ipcMain, Menu } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { SqliteLocalStore } from "@workspace/adapters";
import { LocalContentService } from "@workspace/core";
import type { LocalSaveResult } from "@workspace/contracts";
import type { DemoLoadResult, DemoSaveInput } from "../bridge/contracts.js";

const scope = { workspaceId: "status-demo", domainId: "demo-notes", recordId: "current-note" };
let store: SqliteLocalStore | undefined;
let window: BrowserWindow | undefined;
let shuttingDown = false;
let shutdownComplete = false;

function checkSender(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== window.webContents.getURL()) throw new Error("Unavailable caller");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512;
}

app.whenReady().then(async () => {
  store = await SqliteLocalStore.open({ databasePath: process.env.WORKSPACE_STATUS_DATA ??
    join(app.getPath("userData"), "status-demo", "workspace.sqlite") });
  const persistence = store;
  const service = new LocalContentService(persistence);
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    title: "统一工作空间 · 保存状态", width: 1100, height: 900, minWidth: 640, minHeight: 640,
    show: process.env.WORKSPACE_STATUS_HIDDEN !== "1", backgroundColor: "#f4f5f7",
    webPreferences: { preload: fileURLToPath(new URL("../bridge/preload.cjs", import.meta.url)),
      contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false,
      offscreen: process.env.WORKSPACE_STATUS_HIDDEN === "1" },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  ipcMain.handle("status-demo:save", async (event, input: unknown): Promise<LocalSaveResult> => {
    checkSender(event);
    const candidate = input as Partial<DemoSaveInput> | null;
    if (!candidate || !validId(candidate.operationId) || typeof candidate.text !== "string" || !candidate.text.trim() || candidate.text.length > 32000) {
      return { status: "not-saved", reason: "invalid-input", message: "请先填写需要保存的内容。" };
    }
    return service.save({ ...scope, operationId: candidate.operationId, kind: "put", payload: { text: candidate.text } });
  });
  ipcMain.handle("status-demo:recover", async (event, operationId: unknown): Promise<LocalSaveResult> => {
    checkSender(event);
    if (!validId(operationId)) return { status: "not-saved", reason: "invalid-input", message: "操作信息不完整。" };
    return service.recover({ ...scope, operationId });
  });
  ipcMain.handle("status-demo:load", async (event): Promise<DemoLoadResult> => {
    checkSender(event);
    try {
      const record = await persistence.readRecord(scope);
      if (!record) return { ok: true, record: null, receipt: null };
      const receipt = (await persistence.listPending(scope)).find((item) => item.recordId === scope.recordId && item.localSequence === record.localSequence);
      if (!receipt) return { ok: false, message: "内容仍在本机，但暂时无法核对其保存状态。" };
      return { ok: true, record, receipt };
    } catch { return { ok: false, message: "暂时无法读取本机内容，请保留当前输入后重试。" }; }
  });
  await window.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
}).catch((error: unknown) => {
  console.error("Status demo could not start.", error instanceof Error ? error.message : "Unknown failure");
  app.exit(1);
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (shutdownComplete || !store) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  store.close().finally(() => { shutdownComplete = true; app.quit(); });
});

