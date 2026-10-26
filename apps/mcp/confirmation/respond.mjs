export async function confirmWithClient(server, remote, pending, retry) {
  if (!server.getClientCapabilities()?.elicitation?.form) return pending;
  const response = await server.elicitInput({ mode: "form", message: "确认删除：" + pending.object + "\n空间领域：" + pending.domainId + "\n对象：" + pending.recordId + "\n依据版本：" + pending.revision,
    requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "确认删除此对象（无法通过日常入口撤销）" } }, required: ["approve"] } });
  const accepted = response.action === "accept" && response.content?.approve === true;
  await remote("respond-confirmation", { operationId: pending.operationId, challenge: pending.challenge, accepted });
  return accepted ? retry() : { status: "cancelled", operationId: pending.operationId };
}
