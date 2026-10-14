#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/dev.sh [--port PORT]

Starts the development stack. Each instance uses a block of consecutive
ports: gateway PORT (open this one), the control plane's public API PORT+1
and internal API PORT+2 (one process), web PORT+3, LLM gateway PORT+4,
runtime gateway PORT+5, memory service PORT+6 and the agenvo relay PORT+8
(HTTPS with a self-signed certificate, for remote computers); PORT+7 and
PORT+9 are spare.

  --port PORT   Use exactly this gateway port; fail if any port of its block is taken.
                Also settable as AXP_DEV_PORT.

Without --port the default is 3000. When that block is taken (another checkout,
worktree or agent is running) the next free block in steps of 10 is used, so
any number of instances can start in parallel.

Every agent runs in a container of its own, from an image the controller
builds on the runtime image (rebuilt on every start) out of the agent's
bundles, with its state on a volume of its own (axp-dev-agent-<id>).

Needs Docker. One set of supporting containers per machine, shared by every
instance and kept running between sessions: PostgreSQL, OpenObserve for
logs (opened through the gateway at /observe/) with an OpenTelemetry Collector
for runtimes, and NATS, where runtimes publish their events. They are named
axp-dev-* and never touch production's.
EOF
}

# Resolve the workspace from this script so it works from any directory.
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source scripts/dev-container.sh

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

for command in bun node uv go docker; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required command: $command" >&2
    exit 1
  fi
done
if ! docker info >/dev/null 2>&1; then
  echo "Cannot talk to Docker; is it running and are you in the docker group?" >&2
  exit 1
fi
# Development settings, development's runtime network and storage.
export AXP_DEV=true

# Fresh checkouts and worktrees bootstrap themselves.
if [[ ! -f node_modules/concurrently/dist/bin/concurrently.js ]]; then
  bun install
fi
if [[ ! -d apps/memory-service/.venv ]]; then
  uv sync --project apps/memory-service --dev
fi
bash scripts/dev-postgres.sh
go -C apps/control-plane run . migrate
# The GitHub App's credentials moved with code hosting into the control
# plane (#241); a checkout connected before keeps its App.
if [[ -d apps/forge-service/var/forge && ! -e apps/control-plane/var/forge ]]; then
  mkdir -p apps/control-plane/var
  mv apps/forge-service/var/forge apps/control-plane/var/forge
fi

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

BLOCK_SIZE=10

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
export AXP_RUNTIME_GATEWAY_PORT="$((web_port + 5))"
export AXP_MEMORY_PORT="$((web_port + 6))"
# Services listen on loopback, which runtime containers cannot reach; the
# runtime gateway alone listens on the runtime network's gateway address (its
# subnet is fixed in development). As in production, the browser and runtimes
# each reach the services only through their gateway (apps/gateway).
export AXP_GATEWAY_BIND=127.0.0.1
export AXP_RUNTIME_GATEWAY_BIND=172.30.0.1
export AXP_RUNTIME_GATEWAY_URL="http://$AXP_RUNTIME_GATEWAY_BIND:$AXP_RUNTIME_GATEWAY_PORT"
export AXP_LLM_ADDR="127.0.0.1:$AXP_LLM_PORT"
export AXP_LLM_GATEWAY_URL="http://$AXP_LLM_ADDR"
export AXP_UPSTREAM_WEB="127.0.0.1:$AXP_WEB_PORT"
export AXP_UPSTREAM_API="127.0.0.1:$AXP_API_PORT"
export AXP_UPSTREAM_INTERNAL="127.0.0.1:$AXP_INTERNAL_PORT"
export AXP_UPSTREAM_LLM="$AXP_LLM_ADDR"
export AXP_MEMORY_ADDR="127.0.0.1:$AXP_MEMORY_PORT"
export AXP_UPSTREAM_MEMORY="$AXP_MEMORY_ADDR"
export AXP_RELAY_PORT="$((web_port + 8))"

# Instances share the runtime network; only their ports differ.
go -C apps/control-plane run . ensure-runtime-network
runtime_network=axp-runtime
# This checkout's runtime image, rebuilt on every start so runtime changes
# are never stale; with Turbo and Docker's layer cache an unchanged image
# takes about a second. Agents' images build on it, so worktrees never
# overwrite each other's: whichever controller runs moves the agents onto
# its own.
export AXP_RUNTIME_IMAGE="axp-agent-runtime:dev-$(printf '%s' "$ROOT_DIR" | sha256sum | cut -c1-8)"
bash scripts/build/runtime-image.sh "$AXP_RUNTIME_IMAGE"
# The memory service's embedding model, downloaded once and cached by Turbo,
# and the web client's types from the control plane's OpenAPI document.
bunx turbo run build --filter=@axp/memory-service --output-logs=errors-only
bunx turbo run generate --filter=@axp/web --output-logs=errors-only
# What remote computers download (/remote/dl) and the relay (apps/agenvo).
bunx turbo run build --filter=@axp/remote --filter=@axp/agenvo --output-logs=errors-only

# --- Relay ------------------------------------------------------------------------
# agenvo accepts only an HTTPS base URL, so development's relay
# is not behind the (plain HTTP) gateway as in production: it serves TLS
# itself, under production's path, with a self-signed certificate kept with
# its state in var/relay. Connectors on this machine trust it through
# NODE_EXTRA_CA_CERTS (`axp setup --ca-file`). When this instance's port
# changes, running `axp setup` again moves paired connectors to it.
relay_dir="$ROOT_DIR/var/relay"
mkdir -p "$relay_dir"
chmod 700 "$relay_dir"
if [[ ! -f "$relay_dir/cert.pem" ]]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
    -keyout "$relay_dir/key.pem" -out "$relay_dir/cert.pem" -subj /CN=localhost \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null
fi
[[ -f "$relay_dir/admin_secret" ]] || (umask 077 && openssl rand -hex 32 >"$relay_dir/admin_secret")
cat >"$relay_dir/relay.json" <<EOF
{"baseUrl": "https://localhost:$AXP_RELAY_PORT/remote/relay", "dataDir": "$relay_dir/data", "host": "127.0.0.1",
 "port": $AXP_RELAY_PORT, "tls": {"cert": "$relay_dir/cert.pem", "key": "$relay_dir/key.pem"}}
EOF
export AXP_RELAY_URL="https://localhost:$AXP_RELAY_PORT"
export AXP_RELAY_BASE_URL="$AXP_RELAY_URL/remote/relay"
export AXP_RELAY_CA_FILE="$relay_dir/cert.pem"
AXP_RELAY_ADMIN_SECRET="$(<"$relay_dir/admin_secret")"
export AXP_RELAY_ADMIN_SECRET

# --- Object storage ---------------------------------------------------------------
# SeaweedFS's S3 API, where artifacts' files are, on loopback (the control
# plane's default AXP_S3_ENDPOINT in development). Only the control plane
# talks to it; it is not on the runtime network. Shared by every instance.
dev_container axp-dev-s3 chrislusf/seaweedfs:4.48 \
  -p 127.0.0.1:18333:8333 -v axp-dev-s3:/data \
  -e AWS_ACCESS_KEY_ID=axp-dev -e AWS_SECRET_ACCESS_KEY=axp-dev-secret \
  -- mini -dir=/data

# --- NATS -----------------------------------------------------------------------
# JetStream, on the runtime network's gateway address, so host processes and
# runtimes use one URL.
dev_container axp-dev-nats nats:2.14-alpine \
  --network "$runtime_network" -p "$AXP_RUNTIME_GATEWAY_BIND:4222:4222" -v axp-dev-nats:/data \
  -- --jetstream --store_dir /data --http_port 8222
for _ in $(seq 1 60); do
  docker exec axp-dev-nats wget -q -O /dev/null http://127.0.0.1:8222/healthz 2>/dev/null && break
  sleep 0.5
done

# --- OpenObserve ----------------------------------------------------------------
# Dev-only credentials; it listens on loopback only.
OBSERVE_USER=root@axp.local
OBSERVE_PASSWORD=Axp-dev-observe-1
observe_basic="$(printf '%s' "$OBSERVE_USER:$OBSERVE_PASSWORD" | base64 | tr -d '\n')"
# Served under /observe so the gateway proxies it as in production. It joins
# the runtime network for the collector.
dev_container axp-dev-openobserve public.ecr.aws/zinclabs/openobserve:v1.0.4 \
  --network "$runtime_network" -p "127.0.0.1:${AXP_DEV_OBSERVE_PORT:-5080}:5080" \
  -v axp-dev-openobserve:/data -e ZO_DATA_DIR=/data -e ZO_BASE_URI=/observe \
  -e ZO_ROOT_USER_EMAIL="$OBSERVE_USER" -e ZO_ROOT_USER_PASSWORD="$OBSERVE_PASSWORD"
observe_port="$(docker port axp-dev-openobserve 5080/tcp | head -n1 | sed 's/.*://')"
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$observe_port/observe/healthz" >/dev/null && break
  sleep 0.5
done
export AXP_UPSTREAM_OBSERVE="127.0.0.1:$observe_port"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:$observe_port/observe/api/default"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic%20$observe_basic"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=development,axp.dev.port=$web_port"
# Runtimes export without credentials to the collector on their network (as
# in production). Its config is passed by value so the container outlives
# this checkout.
dev_container axp-dev-otel-collector otel/opentelemetry-collector-contrib:0.162.0 \
  --network "$runtime_network" --network-alias otel-collector \
  -e OTELCOL_CONFIG="$(cat deploy/otel-collector.yaml)" \
  -e OPENOBSERVE_ENDPOINT=http://axp-dev-openobserve:5080/observe/api/default \
  -e OPENOBSERVE_AUTHORIZATION="Basic $observe_basic" \
  -- --config=env:OTELCOL_CONFIG
exec 9>&-

cat <<EOF
AXP dev in $ROOT_DIR
  Web:      http://localhost:$AXP_GATEWAY_PORT
  API:      http://localhost:$AXP_GATEWAY_PORT/api/health
  Internal: http://127.0.0.1:$AXP_INTERNAL_PORT/internal/docs
  Logs:     http://localhost:$AXP_GATEWAY_PORT/observe/ ($OBSERVE_USER / $OBSERVE_PASSWORD)
  Relay:    $AXP_RELAY_BASE_URL (connectors trust $AXP_RELAY_CA_FILE)
EOF

# Both gateways (production's two roles) in one Caddy on the host network, so
# it binds the addresses above; the configuration is read from this checkout.
gateway=axp-dev-gateway-$web_port
docker rm -f "$gateway" >/dev/null 2>&1 || true
gateway_env=""
for name in AXP_GATEWAY_BIND AXP_GATEWAY_PORT AXP_RUNTIME_GATEWAY_BIND AXP_RUNTIME_GATEWAY_PORT \
  AXP_UPSTREAM_WEB AXP_UPSTREAM_API AXP_UPSTREAM_INTERNAL AXP_UPSTREAM_LLM AXP_UPSTREAM_MEMORY \
  AXP_UPSTREAM_OBSERVE; do
  gateway_env+=" -e $name"
done

# Every process stops on Ctrl+C or when any of them exits.
exec node node_modules/concurrently/dist/bin/concurrently.js --kill-others \
  --names gateway,control-plane,controller,routine-worker,llm,memory,relay,web \
  --prefix-colors gray,blue,cyan,yellow,magenta,red,gray,green \
  "docker run --rm --name $gateway --network host$gateway_env -v $ROOT_DIR/apps/gateway:/etc/axp-gateway:ro caddy:2.11.7-alpine caddy run --config /etc/axp-gateway/Caddyfile" \
  "OTEL_SERVICE_NAME=control-plane bun run dev:control-plane" \
  "OTEL_SERVICE_NAME=control-plane-controller bun run dev:controller" \
  "OTEL_SERVICE_NAME=control-plane-routine-worker bun run dev:routine-worker" \
  "bun run dev:llm-gateway" \
  "bun run dev:memory-service" \
  "AGENVO_ADMIN_SECRET=\$AXP_RELAY_ADMIN_SECRET node apps/agenvo/out/relay/node_modules/@agenvo/server/dist/cli.js serve --config $relay_dir/relay.json" \
  "bun run dev:web"
