import { managementPage } from "./management-page.js";
import { WorkspaceMcp } from "../composition/workspace-mcp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WorkspaceSync } from "../composition/workspace-sync.js";
import { createServer } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { WorkspaceInitialization } from "@workspace/core";
import { SqliteWorkspaceAuthority } from "@workspace/adapters";
import { acquireServiceLease } from "../lifecycle/lease.js";

export async function startWorkspaceServer(options: { directory: string; token: string; port?: number; host?: string }) {
  if (options.token.length < 32) throw new Error("Provide a bootstrap owner credential of at least 32 characters");
  const release = acquireServiceLease(options.directory);
  const authority = new SqliteWorkspaceAuthority(options.directory);
  const service = new WorkspaceInitialization(authority, randomUUID, () => new Date().toISOString());
  const requests = new Set<Promise<void>>();
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    const reply = (status: number, value: unknown) => { response.writeHead(status); response.end(JSON.stringify(value)); };
    if (request.method === "GET" && request.url === "/manage") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("content-security-policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
      response.end(managementPage); return;
    }
    const expected = Buffer.from("Bearer " + options.token);
    const provided = Buffer.from(request.headers.authorization ?? "");
    const owner = provided.length === expected.length && timingSafeEqual(provided, expected);
    const mcp = request.url?.startsWith("/v1/mcp/");
    if (!owner && !(mcp && request.headers.authorization?.startsWith("Bearer "))) { request.resume(); reply(401, { error: "Unauthorized" }); return; }
    try {
      if (request.method === "POST" && request.url === "/v1/sync/capabilities") { request.resume(); reply(200, { atomicProtocol: 1 }); return; }
      if (request.method === "GET" && request.url === "/v1/identity") { reply(200, await authority.inspect()); return; }
      if (request.method !== "POST" || (!mcp && !["/v1/initialize", "/v1/sync/upload", "/v1/sync/pull"].includes(request.url ?? ""))) { request.resume(); reply(404, { error: "Unavailable endpoint" }); return; }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
        length += Buffer.byteLength(chunk);
        if (length > (request.url === "/v1/initialize" ? 32768 : 8 * 1024 * 1024)) { reply(413, { status: "rejected", reason: "invalid-input", message: "创建请求过大。" }); return; }
      }
      let input: unknown;
      try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { reply(400, { status: "rejected", reason: "invalid-input", message: "创建请求无法识别。" }); return; }
      if (mcp) {
        try { reply(200, await new WorkspaceMcp(options.directory).execute(owner, (request.headers.authorization ?? "").slice(7), request.url!.slice("/v1/mcp/".length), input as import("@workspace/contracts").JsonObject)); }
        catch (error) {
          const uncertain = error instanceof Error && error.name === "LocalStoreError";
          reply(uncertain ? 503 : 403, { status: uncertain ? "unconfirmed" : "rejected", message: uncertain ? "原操作结果待核对，请使用原调用身份接续。" : error instanceof Error ? error.message : "MCP 请求未执行。" });
        }
        return;
      }
      if (request.url !== "/v1/initialize") {
        reply(200, await new WorkspaceSync(options.directory).execute(request.url === "/v1/sync/upload" ? "upload" : "pull", input)); return;
      }
      const result = await service.create(input as Parameters<typeof service.create>[0]);
      reply(result.status === "created" ? 200 : result.status === "rejected" ? 409 : 503, result);
    } catch { reply(503, { status: "unconfirmed", message: "创建结果暂不能确认，请核对原请求。" }); }
  };
  const server = createServer((request, response) => {
    const running = handle(request, response).catch(() => { response.destroy(); });
    requests.add(running); void running.finally(() => requests.delete(running));
  });
  server.requestTimeout = 10000;
  try {
    // Fetch/browser transports reserve some low ports. Automatic local endpoints
    // use the high dynamic range so an otherwise healthy service is reachable.
    for (let attempt = 0; ; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(options.port || 49152 + Math.floor(Math.random() * 16384), options.host ?? "127.0.0.1", () => { server.off("error", reject); resolve(); });
        });
        break;
      } catch (error) {
        // Windows may reserve otherwise-unused dynamic ports; retry only automatic selection.
        if (!options.port && ["EADDRINUSE", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "") && attempt < 31) continue;
        throw error;
      }
    }
  } catch (error) { release(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing service address");
  return { url: "http://127.0.0.1:" + address.port,
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => { void Promise.allSettled([...requests]).then(() => { release(); error ? reject(error) : resolve(); }); }); }) };
}

