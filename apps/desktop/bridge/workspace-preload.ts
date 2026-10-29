import { contextBridge, ipcRenderer } from "electron";
import type { WorkspaceBridge } from "./workspace-contracts.js";
const api: WorkspaceBridge = {
  tunnel: (action, config) => ipcRenderer.invoke("workspace:tunnel", action, config),
  update: action => ipcRenderer.invoke("workspace:update", action),
  migration: (action, target) => ipcRenderer.invoke("workspace:migration", action, target),
  recovery: (action, ticket) => ipcRenderer.invoke("workspace:recovery", action, ticket),
  exportFile: source => ipcRenderer.invoke("workspace:export-file", source),
  exportScope: source => ipcRenderer.invoke("workspace:export-scope", source),
  mcp: (method, input) => ipcRenderer.invoke("workspace:mcp", method, input),
  sync: (action) => ipcRenderer.invoke("workspace:sync", action),
  inspect: (form) => ipcRenderer.invoke("workspace:inspect", form),
  connect: (ticket) => ipcRenderer.invoke("workspace:connect", ticket),
  domains: (request) => ipcRenderer.invoke("workspace:domains", request),
  windowAction: (action) => ipcRenderer.invoke("workspace:window", action),
  onCloseRequested: (listener) => { ipcRenderer.on("workspace:close-request", listener); return () => { ipcRenderer.removeListener("workspace:close-request", listener); }; },
  load: () => ipcRenderer.invoke("workspace:load"),
  chooseDirectory: () => ipcRenderer.invoke("workspace:choose-directory"),
  create: (form) => ipcRenderer.invoke("workspace:create", form),
};
contextBridge.exposeInMainWorld("workspaceSetup", api);

