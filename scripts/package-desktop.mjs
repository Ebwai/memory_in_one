import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DESKTOP_VERSION } from "../apps/desktop/dist/bridge/update-contracts.js";

if (process.platform !== "win32") throw new Error("Build Windows distribution on Windows.");
const source = resolve(".build/release/workspace-windows-v0.1.0");
const output = resolve(`.build/release/workspace-windows-v${DESKTOP_VERSION}-${process.arch}.zip`);
const temporary = output.replace(/\.zip$/, `-${Date.now()}.partial.zip`);
// Paths travel as environment values, never as interpolated PowerShell code.
await new Promise((done, fail) => {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Compress-Archive -LiteralPath $env:WORKSPACE_PACKAGE_SOURCE -DestinationPath $env:WORKSPACE_PACKAGE_OUTPUT -CompressionLevel Optimal"], {
    env: { ...process.env, WORKSPACE_PACKAGE_SOURCE: source, WORKSPACE_PACKAGE_OUTPUT: temporary }, windowsHide: true, stdio: "inherit"
  });
  child.once("error", fail); child.once("exit", code => code === 0 ? done() : fail(new Error("Archive creation failed.")));
});
await rename(temporary, output);
const hash = createHash("sha256");
for await (const chunk of createReadStream(output)) hash.update(chunk);
await writeFile(output + ".sha256", `${hash.digest("hex")}  ${output.split(/[\\/]/).at(-1)}\n`);
console.log(output);
