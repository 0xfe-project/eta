#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/dev.sh [--port PORT]

Starts the development stack. Each instance uses a block of consecutive
ports: edge gateway PORT (open this one), control plane PORT+1, internal
runtime API PORT+2 (docker mode), web PORT+3 and LLM gateway PORT+4.

  --port PORT   Use exactly this gateway port; fail if any port of its block is taken.
                Also settable as AXP_DEV_PORT.

Without --port the default is 3000. When that block is taken (another checkout,
worktree or agent is running) the next free block in steps of 10 is used, so
any number of instances can start in parallel.

AXP_RUNTIME_MODE=docker runs real agent containers instead of the fake worker.

Logs also go to a local OpenObserve (one per machine, shared by every
instance), opened through the gateway at /observe/. It needs Docker;
AXP_DEV_OBSERVE=0 keeps logs in the terminal only.
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

for command in bun node uv go; do
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
production_ports=" $AXP_PROD_HTTP_PORT $AXP_PROD_HTTPS_PORT $AXP_PROD_REGISTRY_PORT $AXP_PROD_OBSERVE_PORT "

BLOCK_SIZE=5

block_free() {
  local port
  for ((port = $1; port < $1 + BLOCK_SIZE; port++)); do
    if [[ "$production_ports" == *" $port "* ]] || port_listening "$port" || port_reserved "$port"; then
      return 1
    fi
  done
}

if [[ -n "$requested_port" ]]; then
  web_port="$requested_port"
  if ! block_free "$web_port"; then
    echo "Ports $web_port-$((web_port + BLOCK_SIZE - 1)) are not all free (or reserved for production in deploy/ports.env)." >&2
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
for ((port = web_port; port < web_port + BLOCK_SIZE; port++)); do
  echo "$$" >"$STATE_DIR/$port.pid"
done

export AXP_GATEWAY_PORT="$web_port"
export AXP_API_PORT="$((web_port + 1))"
export AXP_INTERNAL_PORT="$((web_port + 2))"
export AXP_WEB_PORT="$((web_port + 3))"
export AXP_LLM_PORT="$((web_port + 4))"
export CONTROL_PLANE_URL="http://127.0.0.1:$AXP_API_PORT"
# Everything the browser uses goes through the edge gateway, as in production.
export AXP_GATEWAY_ADDR="127.0.0.1:$AXP_GATEWAY_PORT"
export AXP_GATEWAY_UPSTREAM_WEB="http://127.0.0.1:$AXP_WEB_PORT"
export AXP_GATEWAY_UPSTREAM_API="$CONTROL_PLANE_URL"
export AXP_EDGE_SECRET="${AXP_EDGE_SECRET:-dev-edge-$(id -u)-$web_port}"
export AXP_INTERNAL_HOST="${AXP_INTERNAL_HOST:-172.30.0.1}"
export AXP_INTERNAL_URL="http://$AXP_INTERNAL_HOST:$AXP_INTERNAL_PORT"
# The LLM gateway keeps credentials under apps/llm-gateway/var, shared by
# every instance of this checkout. Runtime containers reach it on the
# runtime network's gateway address, so in docker mode it listens there.
export AXP_LLM_STATE_DIR="${AXP_LLM_STATE_DIR:-$ROOT_DIR/apps/llm-gateway/var}"
export AXP_LLM_API_KEY="${AXP_LLM_API_KEY:-dev-llm-$(id -u)}"
if [[ "$runtime_mode" == "docker" ]]; then
  llm_host="$AXP_INTERNAL_HOST"
  # Agents need a connected model to chat, as in production.
  export AXP_LLM_GATEWAY_URL="http://$llm_host:$AXP_LLM_PORT"
  export AXP_LLM_RUNTIME_BASE_URL="http://$llm_host:$AXP_LLM_PORT/v1"
else
  llm_host=127.0.0.1
fi
export AXP_LLM_ADDR="$llm_host:$AXP_LLM_PORT"
export AXP_GATEWAY_UPSTREAM_LLM="http://$llm_host:$AXP_LLM_PORT"

if [[ "$runtime_mode" == "docker" ]]; then
  # Instances share the runtime network; only the internal API port differs.
  uv run --project apps/control-plane python apps/control-plane/manage.py ensure_runtime_network
  # Rebuilt on every start so runtime changes are never stale; with Turbo and
  # Docker's layer cache an unchanged image takes about a second. A custom
  # AXP_RUNTIME_IMAGE is used as is.
  if [[ -z "${AXP_RUNTIME_IMAGE:-}" ]]; then
    bun run runtime:build
  fi
fi

# --- OpenObserve ---------------------------------------------------------------
# One container per machine, left running between sessions like the runtime
# network. Dev-only credentials; it listens on loopback only.
OBSERVE_CONTAINER=axp-dev-openobserve
OBSERVE_PORT="${AXP_DEV_OBSERVE_PORT:-5080}"
OBSERVE_USER=root@axp.local
OBSERVE_PASSWORD=Axp-dev-observe-1
observe_url=""
if [[ "${AXP_DEV_OBSERVE:-1}" == "0" ]]; then
  :
elif ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is not available; logs stay in the terminal (AXP_DEV_OBSERVE=0 hides this)." >&2
else
  # Served under /observe so the gateway proxies it as in production.
  # Recreated (data kept in the volume) when its image or settings change.
  observe_image=public.ecr.aws/zinclabs/openobserve:v1.0.4
  observe_hash="$(printf '%s\n%s' "$observe_image" /observe | sha256sum | cut -c1-12)"
  if [[ "$(docker inspect -f '{{index .Config.Labels "axp.config"}}' "$OBSERVE_CONTAINER" 2>/dev/null || true)" != "$observe_hash" ]]; then
    docker rm -f "$OBSERVE_CONTAINER" >/dev/null 2>&1 || true
    docker run -d --name "$OBSERVE_CONTAINER" --restart unless-stopped \
      --label "axp.config=$observe_hash" \
      -p "127.0.0.1:$OBSERVE_PORT:5080" -v axp-dev-openobserve:/data \
      -e ZO_DATA_DIR=/data -e ZO_BASE_URI=/observe \
      -e ZO_ROOT_USER_EMAIL="$OBSERVE_USER" \
      -e ZO_ROOT_USER_PASSWORD="$OBSERVE_PASSWORD" \
      "$observe_image" >/dev/null
  fi
  docker start "$OBSERVE_CONTAINER" >/dev/null
  observe_port="$(docker port "$OBSERVE_CONTAINER" 5080/tcp | head -n1 | sed 's/.*://')"
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$observe_port/observe/healthz" >/dev/null && break
    sleep 0.5
  done
  observe_url="http://localhost:$AXP_GATEWAY_PORT/observe/"
  observe_basic="$(printf '%s' "$OBSERVE_USER:$OBSERVE_PASSWORD" | base64 | tr -d '\n')"
  export AXP_GATEWAY_UPSTREAM_OBSERVE="http://127.0.0.1:$observe_port"
  export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:$observe_port/observe/api/default"
  export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic%20$observe_basic"
  export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=development,axp.dev.port=$web_port"

  if [[ "$runtime_mode" == "docker" ]]; then
    # Runtimes export without credentials to a collector on their network
    # (as in production); OpenObserve joins that network for it. The config
    # is passed by value so the container outlives this checkout.
    runtime_network="${AXP_RUNTIME_NETWORK:-axp-runtime}"
    if ! docker inspect -f '{{json .NetworkSettings.Networks}}' "$OBSERVE_CONTAINER" | grep -q "\"$runtime_network\""; then
      docker network connect "$runtime_network" "$OBSERVE_CONTAINER"
    fi
    collector_image=otel/opentelemetry-collector-contrib:0.162.0
    collector_config="$(cat deploy/otel-collector.yaml)"
    # Recreated when its config or image changes.
    collector_endpoint="http://$OBSERVE_CONTAINER:5080/observe/api/default"
    collector_hash="$(printf '%s\n%s\n%s' "$collector_image" "$collector_endpoint" "$collector_config" | sha256sum | cut -c1-12)"
    running_hash="$(docker inspect -f '{{index .Config.Labels "axp.config"}}' axp-dev-otel-collector 2>/dev/null || true)"
    if [[ "$running_hash" != "$collector_hash" ]]; then
      docker rm -f axp-dev-otel-collector >/dev/null 2>&1 || true
      docker run -d --name axp-dev-otel-collector --restart unless-stopped \
        --label "axp.config=$collector_hash" \
        --network "$runtime_network" --network-alias otel-collector \
        -e OTELCOL_CONFIG="$collector_config" \
        -e OPENOBSERVE_ENDPOINT="$collector_endpoint" \
        -e OPENOBSERVE_AUTHORIZATION="Basic $observe_basic" \
        "$collector_image" --config=env:OTELCOL_CONFIG >/dev/null
    fi
    docker start axp-dev-otel-collector >/dev/null
    export AXP_RUNTIME_OTLP_ENDPOINT=http://otel-collector:4318
  fi
fi
exec 9>&-

cat <<EOF
AXP dev ($runtime_mode runtime) in $ROOT_DIR
  Web:      http://localhost:$AXP_GATEWAY_PORT
  API:      http://localhost:$AXP_GATEWAY_PORT/api/health
EOF
[[ "$runtime_mode" == "docker" ]] && echo "  Internal: $AXP_INTERNAL_URL/internal/docs"
[[ -n "$observe_url" ]] && echo "  Logs:     $observe_url ($OBSERVE_USER / $OBSERVE_PASSWORD)"

# The fake mode answers with a scripted worker and needs neither Docker nor
# credentials. Every process stops on Ctrl+C or when any of them exits.
concurrently=(node node_modules/concurrently/dist/bin/concurrently.js --kill-others)
if [[ "$runtime_mode" == "docker" ]]; then
  exec "${concurrently[@]}" \
    --names gateway,control-plane,internal,controller,llm,web \
    --prefix-colors gray,blue,yellow,cyan,magenta,green \
    "bun run dev:gateway" \
    "OTEL_SERVICE_NAME=control-plane-api bun run dev:control-plane" \
    "OTEL_SERVICE_NAME=control-plane-internal bun run dev:internal" \
    "OTEL_SERVICE_NAME=control-plane-controller bun run dev:controller" \
    "bun run dev:llm-gateway" \
    "bun run dev:web"
fi
exec "${concurrently[@]}" \
  --names gateway,control-plane,fake-runtime,llm,web \
  --prefix-colors gray,blue,cyan,magenta,green \
  "bun run dev:gateway" \
  "OTEL_SERVICE_NAME=control-plane-api bun run dev:control-plane" \
  "OTEL_SERVICE_NAME=control-plane-fake-runtime bun run dev:fake-runtime" \
  "bun run dev:llm-gateway" \
  "bun run dev:web"
