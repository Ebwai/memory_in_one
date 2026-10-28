import { cp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
    else throw new Error("Release must not contain symlinks: " + path);
  }
  return result.sort();
}

export async function buildServerRelease() {
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error("Release version must be a safe semantic version");
  const output = resolve(".build/release");
  await mkdir(output, { recursive: true });
  // A fresh staging tree prevents old Electron or client files leaking into server packages.
  const staging = join(output, ".server-stage-" + Date.now());
  await mkdir(staging);
  await cp("apps/server/dist", join(staging, "apps/server/dist"), { recursive: true });
  for (const name of ["contracts", "core", "adapters", "todo-list", "extension-sdk"]) {
    const target = join(staging, "node_modules/@workspace", name);
    await mkdir(target, { recursive: true });
    await cp("packages/" + name + "/dist", join(target, "dist"), { recursive: true });
    await cp("packages/" + name + "/package.json", join(target, "package.json"));
  }
  await mkdir(join(staging, "scripts"));
  for (const script of ["archive-cli.mjs", "check-server.mjs"]) await cp("scripts/" + script, join(staging, "scripts", script));
  await cp("deploy/server", join(staging, "deploy/server"), { recursive: true });
  await cp("extensions", join(staging, "extensions"), { recursive: true });
  await build({ entryPoints: ["apps/mcp/protocol/main.mjs"], outfile: join(staging, "apps/mcp/protocol/main.mjs"), bundle: true, platform: "node", format: "esm", banner: { js: 'import { createRequire as __makeRequire } from "node:module"; const require = __makeRequire(import.meta.url);' } });
  await writeFile(join(staging, "package.json"), JSON.stringify({ name: "workspace-server", version, private: true, type: "module", engines: { node: ">=22.23.0 <23 || >=24.22.0 <25" }, scripts: { start: "node apps/server/dist/composition/main.js", "check:server": "node scripts/check-server.mjs" } }, null, 2) + "\n");
  for (const document of ["使用指南.md", "Ubuntu服务器部署.md", "交付验收.md"]) await cp("docs/" + document, join(staging, document));
  // Normalize deploy text at the packaging boundary regardless of the build host.
  for (const path of await files(join(staging, "deploy"))) {
    const source = (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
    await writeFile(path, path.endsWith(".cmd") ? source.replace(/\n/g, "\r\n") : source);
  }
  const checksum = createHash("sha256");
  for (const path of await files(staging)) checksum.update(relative(staging, path).replaceAll("\\", "/")).update(await readFile(path));
  const releaseId = version + "-" + checksum.digest("hex").slice(0, 16);
  await writeFile(join(staging, "release.json"), JSON.stringify({ version, releaseId, platforms: ["ubuntu-x64", "ubuntu-arm64", "windows-x64"], nodeDownloadVersion: "22.23.4" }, null, 2) + "\n");
  const sums = [];
  for (const path of await files(staging)) sums.push(createHash("sha256").update(await readFile(path)).digest("hex") + "  " + relative(staging, path).replaceAll("\\", "/"));
  await writeFile(join(staging, "SHA256SUMS"), sums.join("\n") + "\n");
  const generic = join(output, `workspace-server-v${version}`);
  // Preserve old generated distributions instead of recursively deleting a computed path.
  for (const name of [`workspace-server-v${version}`, `workspace-server-ubuntu-v${version}`, `workspace-server-windows-v${version}`]) {
    const target = resolve(output, name);
    if (relative(output, target).startsWith("..")) throw new Error("Release target escaped its output directory");
    try { await rename(target, target + ".previous-" + Date.now()); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await cp(staging, target, { recursive: true });
  }
  const archive = join(output, `workspace-server-ubuntu-v${version}.tar.gz`);
  const pendingArchive = archive + ".partial";
  const result = spawnSync("tar", ["-czf", pendingArchive, "-C", output, `workspace-server-ubuntu-v${version}`], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error("Ubuntu archive failed: " + (result.error?.message ?? result.stderr));
  await rename(pendingArchive, archive);
  await writeFile(archive + ".sha256", createHash("sha256").update(await readFile(archive)).digest("hex") + "  " + archive.split(/[/\\]/).at(-1) + "\n");
  return { server: generic, ubuntu: archive, windowsServer: join(output, `workspace-server-windows-v${version}`), releaseId };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await buildServerRelease()));
