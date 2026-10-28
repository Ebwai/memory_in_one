import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { buildServerRelease } from "./build-server-release.mjs";
import { DESKTOP_VERSION } from "../apps/desktop/dist/bridge/update-contracts.js";

const require = createRequire(import.meta.url);
const root = resolve(".build/release/workspace-windows-v0.1.0");
const application = join(root, "resources/app");
await mkdir(application, { recursive: true });
await writeFile(join(root, "workspace-release.json"), JSON.stringify({ version: DESKTOP_VERSION, platform: "win32", arch: process.arch }, null, 2));
await mkdir(join(application, "deploy/desktop"), { recursive: true });
// UTF-8 BOM is required for Windows PowerShell 5.1 to read Chinese filenames.
const updateHelper = (await readFile("deploy/desktop/update-helper.ps1", "utf8")).replace(/^\uFEFF/, "");
await writeFile(join(application, "deploy/desktop/update-helper.ps1"), "\uFEFF" + updateHelper, "utf8");
await cp(dirname(require("electron")), root, { recursive: true });
await rename(join(root, "electron.exe"), join(root, "工作空间.exe"));
await writeFile(join(application, "package.json"), JSON.stringify({ name: "personal-information-workspace", productName: "个人信息工作空间", version: DESKTOP_VERSION, type: "module", main: "apps/desktop/dist/host/workspace-main.js" }, null, 2));
for (const name of ["desktop", "server"]) await cp("apps/" + name + "/dist", join(application, "apps", name, "dist"), { recursive: true });
for (const name of ["contracts", "core", "adapters", "todo-list", "extension-sdk", "ui"]) {
  const target = join(application, "node_modules/@workspace", name);
  await mkdir(target, { recursive: true });
  await cp("packages/" + name + "/dist", join(target, "dist"), { recursive: true });
  await cp("packages/" + name + "/package.json", join(target, "package.json"));
}
await build({ entryPoints: ["apps/mcp/protocol/main.mjs"], outfile: join(application, "apps/mcp/protocol/main.mjs"), bundle: true, platform: "node", format: "esm", banner: { js: 'import { createRequire as __makeRequire } from "node:module"; const require = __makeRequire(import.meta.url);' } });
await mkdir(join(application, "scripts"), { recursive: true });
await cp("scripts/archive-cli.mjs", join(application, "scripts/archive-cli.mjs"));
await cp("extensions", join(root, "扩展样例"), { recursive: true });
for (const document of ["使用指南.md", "Ubuntu服务器部署.md", "交付验收.md"]) await cp("docs/" + document, join(root, document));
await writeFile(join(root, "启动服务.cmd"), '@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%~dp0工作空间.exe" "%~dp0resources\\app\\apps\\server\\dist\\composition\\main.js"\r\n', "utf8");
await writeFile(join(root, "恢复数据.cmd"), '@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%~dp0工作空间.exe" "%~dp0resources\\app\\scripts\\archive-cli.mjs" %*\r\n', "utf8");
const serverRelease = await buildServerRelease();
console.log(JSON.stringify({ desktop: join(root, "工作空间.exe"), ...serverRelease, version: JSON.parse(await readFile(join(application, "package.json"), "utf8")).version }));
