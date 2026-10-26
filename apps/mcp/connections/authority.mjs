export function authorityConnection(endpoint, credential) {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error("Use HTTPS or loopback HTTP for the workspace service.");
  return async (method, input = {}) => {
    let response;
    try { response = await fetch(new URL("/v1/mcp/" + method, url), { method: "POST", redirect: "error", headers: { authorization: "Bearer " + credential, "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(15000) }); }
    catch { return { status: "unconfirmed", message: "统一位置不可达或原操作结果待核对。请保留原 operationId 重试或查询状态。" }; }
    const result = await response.json();
    if (response.status === 503) return result;
    if (!response.ok) throw new Error(result.message ?? "接入请求被拒绝。");
    return result;
  };
}
