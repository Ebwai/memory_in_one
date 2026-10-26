import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { authorityConnection } from "../connections/authority.mjs";
import { catalog } from "../tools/catalog.mjs";
import { confirmWithClient } from "../confirmation/respond.mjs";

const endpoint = process.env.WORKSPACE_MCP_URL;
const credential = process.env.WORKSPACE_MCP_TOKEN;
if (!endpoint || !credential) throw new Error("Set WORKSPACE_MCP_URL and WORKSPACE_MCP_TOKEN using a named grant.");
const remote = authorityConnection(endpoint, credential);
const server = new Server({ name: "personal-information-workspace", version: "0.1.0" }, { capabilities: { tools: { listChanged: true } } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: catalog(await remote("tools")) }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const info = await remote("tools");
    const tool = catalog(info).find(t => t.name === request.params.name);
    if (!tool) throw new Error("当前授权或领域状态不提供此工具，请重新发现。");
    const args = request.params.arguments ?? {};
    if (Object.keys(args).some(k => !Object.hasOwn(tool.inputSchema.properties, k)) || tool.inputSchema.required.some(k => !Object.hasOwn(args, k))) throw new Error("工具参数无效或缺少必要依据。");
    const name = request.params.name;
    const method = name === "call_status" ? "status" : name === "content_list" ? "list" : name === "content_get" ? "get" : name === "domain_directory" ? "directory" : ["domain_install", "domain_remove"].includes(name) ? "program" : "write";
    const input = method === "write" || method === "program" ? { ...args, action: name.slice(name.indexOf("_") + 1) } : args;
    let result = await remote(method, input);
    if (result.status === "pending-confirmation") {
      result = await confirmWithClient(server, remote, { ...result, confirmationUrl: new URL(result.confirmationPath, endpoint).href }, () => remote(method, input));
      if (result.status === "pending-confirmation") result.confirmationUrl = new URL(result.confirmationPath, endpoint).href;
    }
    if (["write", "program"].includes(method)) await server.sendToolListChanged();
    return { content: [{ type: "text", text: JSON.stringify(result) }], isError: ["rejected", "failed", "conflict", "unconfirmed"].includes(result.status) };
  } catch (error) { return { content: [{ type: "text", text: JSON.stringify({ status: "rejected", message: error.message }) }], isError: true }; }
});
await server.connect(new StdioServerTransport());
