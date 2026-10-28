#!/usr/bin/env bash
set -euo pipefail
umask 077
package_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
install_root=/opt/personal-workspace
config_dir=/etc/personal-workspace
data_dir=/var/lib/personal-workspace
node_version=22.23.4
check_only=false
if [[ ${1:-} == --check && $# == 1 ]]; then check_only=true
elif [[ $# != 0 ]]; then echo "Usage: sudo bash deploy/server/ubuntu/install.sh [--check]" >&2; exit 1; fi
fail() { echo "Installation stopped: $*" >&2; exit 1; }
[[ -r /etc/os-release ]] || fail "Ubuntu is required."
# os-release is a system-owned operating-system descriptor.
. /etc/os-release
[[ ${ID:-} == ubuntu ]] || fail "This installer targets Ubuntu; Windows has its own launcher."
[[ ${VERSION_ID%%.*} -ge 22 ]] || fail "Ubuntu 22.04 or newer is required."
for command_name in sha256sum tar install getent; do command -v "$command_name" >/dev/null || fail "Missing command: $command_name"; done
[[ -f "$package_root/SHA256SUMS" ]] || fail "Use the complete Ubuntu release archive."
(cd -- "$package_root" && sha256sum --check --status SHA256SUMS) || fail "Package integrity check failed."

node_ok() {
  [[ -n ${1:-} && -x "$1" ]] && "$1" --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    const [major,minor]=process.versions.node.split(".").map(Number);
    if (!((major===22 && minor>=23)||(major===24 && minor>=22))) process.exit(1);
    const db=new DatabaseSync(":memory:"); db.exec("CREATE TABLE check_runtime(id INTEGER) STRICT"); db.close();
  ' >/dev/null 2>&1
}
node_binary=${WORKSPACE_NODE_BINARY:-}
if [[ -z "$node_binary" && -f "$config_dir/server.env" ]]; then
  node_binary=$(sed -n 's/^WORKSPACE_NODE_BINARY=//p' "$config_dir/server.env")
fi
if [[ -n "$node_binary" ]]; then
  [[ "$node_binary" == /* && "$node_binary" != *[[:space:]]* ]] || fail "WORKSPACE_NODE_BINARY must be an absolute path without spaces."
  node_ok "$node_binary" || fail "Configured Node must be 22.23+ or 24.22+ with node:sqlite."
elif node_ok "$install_root/runtime/bin/node"; then node_binary="$install_root/runtime/bin/node"
elif node_ok "$(command -v node || true)"; then node_binary=$(command -v node)
fi
if "$check_only"; then
  [[ -n "$node_binary" ]] || fail "Install Node 22.23+ or 24.22+, or run installation to obtain the pinned runtime."
  echo "Ubuntu package and SQLite runtime verified: $node_binary"
  [[ -d /run/systemd/system ]] || echo "systemd is not PID 1 here; service-manager activation has not been tested."
  exit 0
fi
[[ $EUID == 0 ]] || fail "Run the installer with sudo."
[[ -d /run/systemd/system ]] || fail "A running systemd system manager is required. Use start.sh for manual/WSL operation."
for command_name in systemctl useradd runuser flock curl xz; do command -v "$command_name" >/dev/null || fail "Missing command: $command_name"; done
install -d -m 0755 "$install_root" "$install_root/releases"
exec 9>"$install_root/.install.lock"
flock -n 9 || fail "Another installation is already running."
runtime_temp=''
release_temp=''
cleanup() {
  if [[ -n "$runtime_temp" && "$runtime_temp" == "$install_root"/.runtime.* ]]; then rm -rf -- "$runtime_temp"; fi
  if [[ -n "$release_temp" && "$release_temp" == "$install_root"/releases/.prepare.* ]]; then rm -rf -- "$release_temp"; fi
}
trap cleanup EXIT
if [[ -z "$node_binary" ]]; then
  [[ ! -e "$install_root/runtime" ]] || fail "Existing runtime is incompatible; supply WORKSPACE_NODE_BINARY explicitly."
  case $(uname -m) in x86_64) node_arch=x64;; aarch64|arm64) node_arch=arm64;; *) fail "Only x86_64 and arm64 runtime downloads are supported.";; esac
  runtime_temp=$(mktemp -d "$install_root/.runtime.XXXXXX")
  archive="node-v${node_version}-linux-${node_arch}.tar.xz"
  url="https://nodejs.org/download/release/v${node_version}"
  curl --fail --location --proto '=https' --connect-timeout 20 --max-time 300 "$url/$archive" -o "$runtime_temp/$archive"
  curl --fail --location --proto '=https' --connect-timeout 20 --max-time 60 "$url/SHASUMS256.txt" -o "$runtime_temp/SHASUMS256.txt"
  awk -v filename="$archive" '$2==filename {print; found=1} END {if(!found) exit 1}' "$runtime_temp/SHASUMS256.txt" > "$runtime_temp/runtime.sha256"
  (cd -- "$runtime_temp" && sha256sum --check runtime.sha256) || fail "Node runtime checksum mismatch."
  mkdir "$runtime_temp/extracted"
  tar -xJf "$runtime_temp/$archive" -C "$runtime_temp/extracted" --strip-components=1 --no-same-owner
  node_ok "$runtime_temp/extracted/bin/node" || fail "Downloaded Node does not support this Ubuntu system."
  chmod -R a+rX "$runtime_temp/extracted"
  mv -- "$runtime_temp/extracted" "$install_root/runtime"
  node_binary="$install_root/runtime/bin/node"
fi
release_id=$("$node_binary" --input-type=module -e 'import{readFileSync}from"node:fs";console.log(JSON.parse(readFileSync(process.argv[1],"utf8")).releaseId)' "$package_root/release.json")
[[ "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]+$ ]] || fail "Invalid release identity."
release_dir="$install_root/releases/$release_id"
if [[ -e "$release_dir" ]]; then
  cmp -s "$package_root/SHA256SUMS" "$release_dir/SHA256SUMS" || fail "An unrelated release already uses this identity."
  (cd -- "$release_dir" && sha256sum --check --status SHA256SUMS) || fail "Existing release is damaged; not overwritten."
else
  release_temp=$(mktemp -d "$install_root/releases/.prepare.XXXXXX")
  cp -a -- "$package_root/." "$release_temp/"
  find "$release_temp" -type d -exec chmod 0755 {} +
  find "$release_temp" -type f -exec chmod 0644 {} +
  chmod 0755 "$release_temp/deploy/server/ubuntu/start.sh" "$release_temp/deploy/server/ubuntu/install.sh"
  mv -- "$release_temp" "$release_dir"
  release_temp=''
fi
if ! getent passwd personal-workspace >/dev/null; then
  useradd --system --user-group --home-dir "$data_dir" --no-create-home --shell /usr/sbin/nologin personal-workspace
fi
runuser -u personal-workspace -- "$node_binary" --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db=new DatabaseSync(":memory:"); db.close();' >/dev/null 2>&1 || fail "The service account cannot execute the selected Node; use a system or private runtime outside home directories."
install -d -m 0700 -o personal-workspace -g personal-workspace "$data_dir"
install -d -m 0700 "$config_dir"
if [[ ! -e "$config_dir/server.env" ]]; then
  token=$("$node_binary" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
  # Credential is written once and never emitted to installation logs.
  printf 'WORKSPACE_DATA_DIRECTORY=%s\nWORKSPACE_BOOTSTRAP_TOKEN=%s\nWORKSPACE_HOST=127.0.0.1\nWORKSPACE_PORT=43127\nWORKSPACE_NODE_BINARY=%s\n' "$data_dir" "$token" "$node_binary" > "$config_dir/server.env"
  unset token
  chmod 0600 "$config_dir/server.env"
fi
old_release=''
if [[ -e "$install_root/current" || -L "$install_root/current" ]]; then
  [[ -L "$install_root/current" ]] || fail "current is not an installer-managed symlink."
  old_release=$(readlink -f -- "$install_root/current")
  [[ "$old_release" == "$install_root/releases/"* ]] || fail "Existing current link points outside managed releases."
fi
# Finish all preparation before stopping a running service; data is never replaced.
if systemctl is-active --quiet personal-workspace; then systemctl stop personal-workspace; fi
ln -s -- "$release_dir" "$install_root/.current-$$"
mv -Tf -- "$install_root/.current-$$" "$install_root/current"
install -m 0644 "$release_dir/deploy/server/ubuntu/personal-workspace.service" /etc/systemd/system/personal-workspace.service
systemctl daemon-reload
systemctl enable personal-workspace
if ! systemctl restart personal-workspace; then
  echo "Startup failed. Configuration and data were retained. Inspect: journalctl -u personal-workspace -n 80" >&2
  [[ -z "$old_release" ]] || echo "Previous release retained at: $old_release" >&2
  exit 1
fi
echo "Installed Ubuntu service: personal-workspace"
echo "Configuration: $config_dir/server.env (existing credentials preserved)"
echo "Persistent data: $data_dir"
echo "Status: sudo systemctl status personal-workspace --no-pager"
echo "Set up HTTPS separately, then connect or migrate from your desktop client."
