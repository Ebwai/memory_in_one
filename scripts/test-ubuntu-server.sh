#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
test_dir=$(mktemp -d /tmp/personal-workspace-ubuntu.XXXXXX)
cleanup() { [[ "$test_dir" == /tmp/personal-workspace-ubuntu.* ]] && rm -rf -- "$test_dir"; }
trap cleanup EXIT
version=22.23.4
case $(uname -m) in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo "Unsupported test architecture" >&2; exit 1;; esac
archive="node-v${version}-linux-${arch}.tar.xz"
curl --fail --silent --show-error --location --proto '=https' --connect-timeout 20 --max-time 300 "https://nodejs.org/download/release/v${version}/$archive" -o "$test_dir/$archive"
curl --fail --silent --show-error --location --proto '=https' --connect-timeout 20 --max-time 60 "https://nodejs.org/download/release/v${version}/SHASUMS256.txt" -o "$test_dir/SHASUMS256.txt"
awk -v filename="$archive" '$2==filename {print; found=1} END {if(!found) exit 1}' "$test_dir/SHASUMS256.txt" > "$test_dir/node.sha256"
(cd -- "$test_dir" && sha256sum --check node.sha256)
tar -xJf "$test_dir/$archive" -C "$test_dir"
tar -xzf "$repo/.build/release/workspace-server-ubuntu-v0.1.0.tar.gz" -C "$test_dir"
export WORKSPACE_SERVER_RELEASE="$test_dir/workspace-server-ubuntu-v0.1.0"
node_binary="$test_dir/node-v${version}-linux-${arch}/bin/node"
echo "Actual Ubuntu runtime: $("$node_binary" --version), $(uname -m)"
"$node_binary" --test "$repo/tests/e2e/server-deployment.test.mjs"
