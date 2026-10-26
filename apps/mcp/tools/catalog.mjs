const string = { type: "string" };
const operation = { ...string, pattern: "^[a-zA-Z0-9_-]{1,100}$", description: "同次操作重试必须保留此身份；新的意图使用新身份。" };
const revision = { type: "integer", minimum: 1, description: "查询返回的原版本。" };
export function catalog(info) {
  if (!info.domains) throw new Error("统一位置不可达，不能发现当前工具。");
  const tools = [];
  const add = (name, description, properties, required, readOnly = false) => tools.push({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }, annotations: { readOnlyHint: readOnly, destructiveHint: name.endsWith("delete") || name === "domain_remove", idempotentHint: true } });
  add("call_status", "核对当前接入来源的原调用状态；不执行动作。", { operationId: string }, ["operationId"], true);
  for (const action of info.grant.actions) {
    if (action === "read" && info.domains.length) {
      const domainId = { ...string, enum: info.domains };
      add("content_list", "读取授权领域全部未删除的权威内容，含已完成任务；不包含设备未同步成果。", { domainId }, ["domainId"], true);
      add("content_get", "读取原内容和已确认版本；不存在与领域不可用分别反馈。", { domainId, recordId: string }, ["domainId", "recordId"], true);
    } else if (["create", "update", "date", "complete", "restore", "delete"].includes(action)) {
      const domains = info.domains.filter(id => (info.capabilities?.[id] ?? []).includes(action));
      if (!domains.length) continue;
      const properties = { domainId: { ...string, enum: domains }, operationId: operation };
      const required = ["domainId", "operationId"];
      if (action !== "create") { Object.assign(properties, { recordId: string, revision }); required.push("recordId", "revision"); }
      if (["create", "update"].includes(action)) Object.assign(properties, { text: { ...string, description: "todo-list 任务文字。" }, payload: { type: "object", description: "自定义领域按声明提供的内容。" } });
      if (action === "date") { properties.dueDate = { type: ["string", "null"], description: "YYYY-MM-DD；null 明确清除。" }; required.push("dueDate"); }
      add("content_" + action, action === "delete" ? "删除具体内容；先返回待确认对象，由客户端承接用户确认，不能以参数声称已确认。" : "在原领域规则和统一位置上执行 " + action + "，只有 accepted 表示已确认成功。", properties, required);
    } else if (action === "directory") add("domain_directory", "查询授权领域登记、启用状态、服务器程序可用性及业务声明，包含停用和缺程序领域。", {}, [], true);
    else if (["register", "enable", "disable", "install", "remove"].includes(action)) {
      const properties = { domainId: { ...string, enum: info.authorizedDomains }, operationId: operation };
      const required = ["domainId", "operationId"];
      if (["enable", "disable"].includes(action)) { properties.revision = revision; required.push("revision"); }
      if (["register", "install"].includes(action)) { properties.definition = { type: "object", description: "完整兼容的声明式领域程序。" }; required.push("definition"); }
      if (["install", "remove"].includes(action)) { properties.target = { type: "string", enum: ["server"], description: "只作用于服务器；其他客户端不受影响。" }; required.push("target"); }
      add("domain_" + action, "按独立管理权限执行 " + action + (["install", "remove"].includes(action) ? "（仅服务器程序，保留数据）" : "（工作空间登记及启用状态）"), properties, required);
    }
  }
  return tools;
}
