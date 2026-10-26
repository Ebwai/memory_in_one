import { contextBridge, ipcRenderer } from "electron";
import type { StatusDemoBridge } from "./contracts.js";

const api: StatusDemoBridge = {
  save: (input) => ipcRenderer.invoke("status-demo:save", input),
  recover: (operationId) => ipcRenderer.invoke("status-demo:recover", operationId),
  load: () => ipcRenderer.invoke("status-demo:load"),
};
contextBridge.exposeInMainWorld("statusDemo", api);

