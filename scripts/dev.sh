#!/usr/bin/env bash
set -euo pipefail

# Resolve the workspace from this script so it works from any directory.
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

for command in bun node uv; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required command: $command" >&2
    exit 1
  fi
done

if [[ ! -f node_modules/concurrently/dist/bin/concurrently.js || ! -d apps/control-plane/.venv ]]; then
  echo "Dependencies are missing. Run 'bun run setup' from $ROOT_DIR first." >&2
  exit 1
fi

# Keep the empty agent runtime alive in Node.js watch mode. Stop every process
# on Ctrl+C or when any process exits, including a startup failure.
exec node node_modules/concurrently/dist/bin/concurrently.js \
  --kill-others \
  --names control-plane,web,agent-runtime \
  --prefix-colors blue,green,magenta \
  "bun run dev:control-plane" \
  "bun run dev:web" \
  "bun run dev:agent-runtime"
