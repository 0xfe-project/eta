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

# AXP_RUNTIME_MODE=docker runs real agent containers (Codex via the Python
# SDK): the internal runtime API and the controller. The default "fake" mode
# answers with a scripted worker and needs neither Docker nor credentials.
# Every process stops on Ctrl+C or when any of them exits.
concurrently=(node node_modules/concurrently/dist/bin/concurrently.js --kill-others)
if [[ "${AXP_RUNTIME_MODE:-fake}" == "docker" ]]; then
  command -v docker >/dev/null 2>&1 || { echo "Missing required command: docker" >&2; exit 1; }
  uv run --project apps/control-plane python apps/control-plane/manage.py ensure_runtime_network
  exec "${concurrently[@]}" \
    --names control-plane,internal,controller,web \
    --prefix-colors blue,yellow,cyan,green \
    "bun run dev:control-plane" \
    "bun run dev:internal" \
    "bun run dev:controller" \
    "bun run dev:web"
fi
exec "${concurrently[@]}" \
  --names control-plane,fake-runtime,web \
  --prefix-colors blue,cyan,green \
  "bun run dev:control-plane" \
  "bun run dev:fake-runtime" \
  "bun run dev:web"
