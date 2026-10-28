#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
node_binary=${WORKSPACE_NODE_BINARY:-/opt/personal-workspace/runtime/bin/node}
if [[ ! -x "$node_binary" ]]; then
  echo "Node runtime unavailable: $node_binary" >&2
  exit 1
fi
: "${WORKSPACE_DATA_DIRECTORY:?Set WORKSPACE_DATA_DIRECTORY}"
: "${WORKSPACE_BOOTSTRAP_TOKEN:?Set WORKSPACE_BOOTSTRAP_TOKEN}"
export WORKSPACE_HOST=${WORKSPACE_HOST:-127.0.0.1}
export WORKSPACE_PORT=${WORKSPACE_PORT:-43127}
if [[ ${1:-} == --check ]]; then exec "$node_binary" "$root/scripts/check-server.mjs"; fi
exec "$node_binary" "$root/apps/server/dist/composition/main.js"
