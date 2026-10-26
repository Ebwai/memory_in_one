import { startWorkspaceServer } from "../transport/server.js";
const directory = process.env.WORKSPACE_DATA_DIRECTORY;
const token = process.env.WORKSPACE_BOOTSTRAP_TOKEN;
if (!directory || !token) throw new Error("Set WORKSPACE_DATA_DIRECTORY and WORKSPACE_BOOTSTRAP_TOKEN before starting the service");
const server = await startWorkspaceServer({ directory, token, port: Number(process.env.WORKSPACE_PORT ?? 0),
  host: process.env.WORKSPACE_HOST ?? "127.0.0.1" });
console.log(JSON.stringify({ type: "ready", url: server.url }));
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (closing) return;
  closing = true;
  void server.close().finally(() => process.exit());
});

