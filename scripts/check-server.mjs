const host = process.env.WORKSPACE_HOST ?? "127.0.0.1";
const address = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : host.includes(":") ? `[${host}]` : host;
const token = process.env.WORKSPACE_BOOTSTRAP_TOKEN;
if (!token || token.length < 32) throw new Error("Set the fixed WORKSPACE_BOOTSTRAP_TOKEN before checking the service.");
const url = `http://${address}:${process.env.WORKSPACE_PORT ?? "43127"}/v1/identity`;
let checked = false;
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    const response = await fetch(url, { headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error("Service rejected the configured owner credential.");
    const identity = await response.json();
    if (identity !== null && (typeof identity.workspaceId !== "string" || typeof identity.authorityId !== "string")) throw new Error("Unrecognized service response.");
    console.log(identity ? "Workspace service ready; existing identity retained." : "Workspace service ready; connect a client to initialize or restore a space.");
    checked = true;
    break;
  } catch (error) {
    if (attempt === 19) { console.error("Service readiness check failed:", error.message); break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
if (!checked) process.exitCode = 1;
