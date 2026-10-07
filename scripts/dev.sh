#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/dev.sh [--port PORT]

Starts the development stack. Each instance uses three consecutive ports:
web PORT, control plane PORT+1, internal runtime API PORT+2 (docker mode).

  --port PORT   Use exactly this web port; fail if it or PORT+1/PORT+2 is taken.
                Also settable as AXP_DEV_PORT.

Without --port the default is 3000. When that block is taken (another checkout,
worktree or agent is running) the next free block in steps of 10 is used, so
any number of instances can start in parallel.

AXP_RUNTIME_MODE=docker runs real agent containers instead of the fake worker.
EOF
}

# Resolve the workspace from this script so it works from any directory.
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

requested_port="${AXP_DEV_PORT:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) requested_port="${2:?--port needs a value}"; shift 2 ;;
    --port=*) requested_port="${1#*=}"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done
if [[ -n "$requested_port" && ! "$requested_port" =~ ^[0-9]+$ ]]; then
  echo "Invalid port: $requested_port" >&2
  exit 1
fi

for command in bun node uv; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required command: $command" >&2
    exit 1
  fi
done
runtime_mode="${AXP_RUNTIME_MODE:-fake}"
if [[ "$runtime_mode" == "docker" ]] && ! command -v docker >/dev/null 2>&1; then
  echo "Missing required command: docker" >&2
  exit 1
fi

# Fresh checkouts and worktrees bootstrap themselves.
if [[ ! -f node_modules/concurrently/dist/bin/concurrently.js ]]; then
  bun install
fi
if [[ ! -d apps/control-plane/.venv ]]; then
  uv sync --project apps/control-plane --dev
fi
uv run --project apps/control-plane python apps/control-plane/manage.py migrate --verbosity 0

# --- Port allocation --------------------------------------------------------
# Every running instance records its ports under a shared lock; a reservation
# lives as long as the process that made it (this shell's PID survives the
# final exec), so parallel starts never pick the same block.
STATE_DIR="${XDG_RUNTIME_DIR:-/tmp}/axp-dev-$(id -u)"
mkdir -p "$STATE_DIR"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$STATE_DIR/lock"
  flock 9
fi

port_listening() {
  if command -v ss >/dev/null 2>&1; then
    [[ -n "$(ss -Htln "sport = :$1" 2>/dev/null)" ]]
  else
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  fi
}

port_reserved() {
  local file="$STATE_DIR/$1.pid" pid
  [[ -f "$file" ]] || return 1
  pid="$(<"$file")"
  [[ "$pid" != "$$" ]] && kill -0 "$pid" 2>/dev/null
}

# Production's ports are never used, even when they happen to be free.
source deploy/ports.env
production_ports=" $AXP_PROD_HTTP_PORT $AXP_PROD_HTTPS_PORT $AXP_PROD_REGISTRY_PORT "

block_free() {
  local port
  for port in "$1" "$(($1 + 1))" "$(($1 + 2))"; do
    if [[ "$production_ports" == *" $port "* ]] || port_listening "$port" || port_reserved "$port"; then
      return 1
    fi
  done
}

if [[ -n "$requested_port" ]]; then
  web_port="$requested_port"
  if ! block_free "$web_port"; then
    echo "Ports $web_port-$((web_port + 2)) are not all free (or reserved for production in deploy/ports.env)." >&2
    exit 1
  fi
else
  web_port=3000
  until block_free "$web_port"; do
    web_port=$((web_port + 10))
    if ((web_port > 3990)); then
      echo "No free port block between 3000 and 3990." >&2
      exit 1
    fi
  done
fi
for port in "$web_port" "$((web_port + 1))" "$((web_port + 2))"; do
  echo "$$" >"$STATE_DIR/$port.pid"
done

export AXP_WEB_PORT="$web_port"
export AXP_API_PORT="$((web_port + 1))"
export AXP_INTERNAL_PORT="$((web_port + 2))"
export CONTROL_PLANE_URL="http://127.0.0.1:$AXP_API_PORT"
export AXP_INTERNAL_HOST="${AXP_INTERNAL_HOST:-172.30.0.1}"
export AXP_INTERNAL_URL="http://$AXP_INTERNAL_HOST:$AXP_INTERNAL_PORT"

if [[ "$runtime_mode" == "docker" ]]; then
  # Instances share the runtime network; only the internal API port differs.
  uv run --project apps/control-plane python apps/control-plane/manage.py ensure_runtime_network
  if ! docker image inspect "${AXP_RUNTIME_IMAGE:-axp-agent-runtime:dev}" >/dev/null 2>&1; then
    bun run runtime:build
  fi
fi
exec 9>&-

cat <<EOF
AXP dev ($runtime_mode runtime) in $ROOT_DIR
  Web:      http://localhost:$AXP_WEB_PORT
  API:      $CONTROL_PLANE_URL/api/health
EOF
[[ "$runtime_mode" == "docker" ]] && echo "  Internal: $AXP_INTERNAL_URL/internal/docs"

# The fake mode answers with a scripted worker and needs neither Docker nor
# credentials. Every process stops on Ctrl+C or when any of them exits.
concurrently=(node node_modules/concurrently/dist/bin/concurrently.js --kill-others)
if [[ "$runtime_mode" == "docker" ]]; then
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
