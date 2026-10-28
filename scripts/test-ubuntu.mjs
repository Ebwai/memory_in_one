import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

let command = "bash", args = [resolve("scripts/test-ubuntu-server.sh")];
if (process.platform === "win32") {
  const distro = process.env.WORKSPACE_UBUNTU_DISTRO ?? "Ubuntu";
  const converted = spawnSync("wsl.exe", ["-d", distro, "--", "wslpath", "-a", resolve("scripts/test-ubuntu-server.sh").replaceAll("\\", "/")], { encoding: "utf8", windowsHide: true });
  if (converted.status !== 0) throw new Error("Ubuntu WSL is required for native Linux tests: " + converted.stderr);
  command = "wsl.exe"; args = ["-d", distro, "--", "bash", converted.stdout.trim()];
}
const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
