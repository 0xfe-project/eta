#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/dev.sh [--port PORT]

Starts the development stack. AXP's processes run here, from this checkout:
the control plane's public API PORT+1 and internal API PORT+2 (one process),
its controller and routine worker, and web PORT+3. The gateway is a Nomad
job: PORT (open this one), the runtime gateway PORT+5 and PORT+8, the gateway
over HTTPS (a self-signed certificate in var/relay), AXP's public address
for remote computers and the agenvo relay. The other ports of the block are
spare.

  --port PORT   Use exactly this gateway port; fail if any port of its block is taken.
                Also settable as AXP_DEV_PORT.

Without --port the default is 3000. When that block is taken (another checkout,
worktree or agent is running) the next free block in steps of 10 is used, so
any number of instances can start in parallel.

What runs on Nomad runs on this machine's agent (deploy/README.md), as in
production: the infrastructure in the namespace axp-dev, shared by every
instance and kept running, and per database (DATABASE_URL's, axp by default)
the gateway and bundles' services (the memory, the agenvo relay) in
dev-<database>, agents' runtimes in dev-<database>-agents, from images this
checkout builds with Docker.
EOF
}

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

fail() { echo "dev: $*" >&2; exit 1; }
for command in bun node uv go docker nomad openssl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
nomad status >/dev/null 2>&1 || fail "cannot reach Nomad (NOMAD_ADDR=${NOMAD_ADDR:-http://127.0.0.1:4646}); see deploy/README.md."
# shellcheck source=../deploy/nomad/lib.sh
source deploy/nomad/lib.sh
export AXP_DEV=true

if [[ ! -f node_modules/concurrently/dist/bin/concurrently.js ]]; then
  bun install
fi

# The forge and LLM gateway services' state moved into the control plane
# (#241, #245); keep what an older checkout had.
for moved in apps/forge-service/var/forge:apps/control-plane/var/forge \
  apps/llm-gateway/var/llm-gateway:apps/control-plane/var/llm-gateway; do
  if [[ -d "${moved%%:*}" && ! -e "${moved##*:}" ]]; then
    mkdir -p "$(dirname "${moved##*:}")"
    mv "${moved%%:*}" "${moved##*:}"
  fi
done

# --- Ports -------------------------------------------------------------------------
# Instances take a block of ten ports each; a lock serializes the search so
# two starting at once cannot pick the same block, and each reserves its
# ports (by pid) for the gap between choosing and listening.
STATE_DIR="${XDG_RUNTIME_DIR:-/tmp}/axp-dev-$(id -u)"
mkdir -p "$STATE_DIR"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$STATE_DIR/lock"
  flock 9
fi
port_listening() { [[ -n "$(ss -Htln "sport = :$1" 2>/dev/null)" ]]; }
port_reserved() {
  local file="$STATE_DIR/$1.pid" pid
  [[ -f "$file" ]] || return 1
  pid="$(<"$file")"
  [[ "$pid" != "$$" ]] && kill -0 "$pid" 2>/dev/null
}
PRODUCTION_PORT=24180
BLOCK_SIZE=10
block_free() {
  local port
  for ((port = $1; port < $1 + BLOCK_SIZE; port++)); do
    if ((port == PRODUCTION_PORT)) || port_listening "$port" || port_reserved "$port"; then
      return 1
    fi
  done
}
if [[ -n "$requested_port" ]]; then
  web_port="$requested_port"
  block_free "$web_port" || fail "ports $web_port-$((web_port + BLOCK_SIZE - 1)) are not all free (or one is production's, $PRODUCTION_PORT)."
else
  web_port=3000
  until block_free "$web_port"; do
    web_port=$((web_port + 10))
    ((web_port <= 3990)) || fail "no free port block between 3000 and 3990."
  done
fi
for ((port = web_port; port < web_port + BLOCK_SIZE; port++)); do
  echo "$$" >"$STATE_DIR/$port.pid"
done

export AXP_GATEWAY_PORT="$web_port"
export AXP_API_PORT="$((web_port + 1))"
export AXP_INTERNAL_PORT="$((web_port + 2))"
export AXP_WEB_PORT="$((web_port + 3))"
export AXP_RUNTIME_GATEWAY_PORT="$((web_port + 5))"
export AXP_PUBLIC_PORT="$((web_port + 8))"
export AXP_PUBLIC_GATEWAY_URL="http://127.0.0.1:$AXP_GATEWAY_PORT"
# Where agents and bundles' services (the bridge network) reach the host.
export AXP_RUNTIME_GATEWAY_URL="http://172.26.64.1:$AXP_RUNTIME_GATEWAY_PORT"
export AXP_LLM_GATEWAY_URL="http://127.0.0.1:$AXP_INTERNAL_PORT"
export AXP_PUBLIC_URL="https://localhost:$AXP_PUBLIC_PORT"

# --- Infrastructure --------------------------------------------------------------
# Shared by every instance, in the namespace axp-dev, on fixed ports: the
# database 24433, NATS 24223, the S3 24334 and Rustrak 24081 (production's
# are 24432, 24222, 24333 and 24080).
rustrak_port=24081
nomad namespace apply axp-dev >/dev/null
nomad operator scheduler set-config -memory-oversubscription=true >/dev/null
nomad var put -force -namespace axp-dev nomad/jobs \
  POSTGRES_PASSWORD=axp AXP_S3_ACCESS_KEY_ID=axp-dev AXP_S3_SECRET_ACCESS_KEY=axp-dev-secret \
  RUSTRAK_SESSION_SECRET_KEY=axp-dev-rustrak-session-key-not-a-secret-0123456789abcdef0123456789 \
  RUSTRAK_SUPERUSER=admin@axp.local:axp-dev-rustrak >/dev/null
for volume in postgres nats objects rustrak; do
  ensure_volume axp-dev "$volume"
done
nomad job run -var namespace=axp-dev -var postgres_port=24433 -var nats_port=24223 -var s3_port=24334 -var "rustrak_port=$rustrak_port" \
  deploy/nomad/infra.nomad.hcl >/dev/null || fail "the development infrastructure did not become ready."
for port in 24433 24223 $rustrak_port; do
  wait_port "$port" || fail "the development infrastructure did not become ready."
done

# The instance's namespaces, by database.
database="${DATABASE_URL:-postgres://axp:axp@127.0.0.1:24433/axp}"
database="${database##*/}"
database="${database%%\?*}"
export AXP_NAMESPACE="dev-${database//_/-}"
nomad namespace apply "$AXP_NAMESPACE" >/dev/null
nomad namespace apply "$AXP_NAMESPACE-agents" >/dev/null

go -C apps/control-plane run . migrate

# --- Images ------------------------------------------------------------------------
# The runtime image agents' images are built on, and bundles' services'
# images: one tag per checkout, so worktrees never overwrite each other's.
# Docker's cache makes an unchanged image cost about a second.
export AXP_IMAGE_TAG="dev-$(printf '%s' "$ROOT_DIR" | sha256sum | cut -c1-8)"
export AXP_RUNTIME_IMAGE="axp-agent-runtime:$AXP_IMAGE_TAG"
image() { AXP_IMAGE="$2:$AXP_IMAGE_TAG" bunx turbo run "image:linux-$(arch)" --filter="$1" --output-logs=errors-only; }
image @axp/agent-runtime axp-agent-runtime
image @axp/memory-service axp-memory
image @axp/agenvo axp-relay
# The web's generated types and what remote computers download.
bunx turbo run generate --filter=@axp/web --output-logs=errors-only
bunx turbo run build --filter=@axp/remote --output-logs=errors-only

# --- The gateway ---------------------------------------------------------------------
# AXP's HTTPS address (the public URL remote computers and the relay use):
# a self-signed certificate for localhost, made once per checkout. The relay
# reads the key through the gateway's bind mount.
tls_dir="$ROOT_DIR/var/relay"
mkdir -p "$tls_dir"
chmod 700 "$tls_dir"
if [[ ! -f "$tls_dir/cert.pem" ]]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
    -keyout "$tls_dir/key.pem" -out "$tls_dir/cert.pem" -subj /CN=localhost \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null
fi
chmod 644 "$tls_dir/key.pem"
rm -rf var/gateway
cp -r apps/gateway var/gateway
cp scripts/dev-https.caddy var/gateway/
nomad job run -var "namespace=$AXP_NAMESPACE" -var "port=$web_port" -var "root=$ROOT_DIR" -var "rustrak_port=$rustrak_port" \
  scripts/dev-gateway.nomad.hcl >/dev/null || fail "the gateway did not become ready."
# Stopped when this script ends (so no exec below).
stop_gateway() { nomad job stop -namespace "$AXP_NAMESPACE" -purge -detach gateway >/dev/null 2>&1 || true; }
trap stop_gateway EXIT

# Errors and logs go to the shared Rustrak, each instance its own environment.
rustrak_admin=admin@axp.local:axp-dev-rustrak
SENTRY_DSN="$(RUSTRAK_URL="http://127.0.0.1:$rustrak_port" RUSTRAK_SUPERUSER="$rustrak_admin" bun deploy/rustrak.ts dsn)" ||
  fail "cannot get the DSN from Rustrak at http://127.0.0.1:$rustrak_port."
export SENTRY_DSN SENTRY_ENVIRONMENT="development-$web_port"

# Another instance may start now: the ports are listened on or reserved.
exec 9>&-

cat <<EOF
AXP dev in $ROOT_DIR
  Web:      http://localhost:$AXP_GATEWAY_PORT
  API:      http://localhost:$AXP_GATEWAY_PORT/api/health
  Internal: http://127.0.0.1:$AXP_INTERNAL_PORT/internal/docs
  Rustrak:  http://127.0.0.1:$rustrak_port (${rustrak_admin%%:*} / ${rustrak_admin#*:}), environment $SENTRY_ENVIRONMENT
  DSN:      $SENTRY_DSN (this machine's)
  Public:   $AXP_PUBLIC_URL (remote computers trust $tls_dir/cert.pem)
  Nomad:    nomad job status -namespace $AXP_NAMESPACE; nomad job status -namespace $AXP_NAMESPACE-agents
EOF

node node_modules/concurrently/dist/bin/concurrently.js --kill-others \
  --names control-plane,controller,routine-worker,web \
  --prefix-colors blue,cyan,yellow,green \
  "bun run dev:control-plane" \
  "bun run dev:controller" \
  "bun run dev:routine-worker" \
  "bun run dev:web"
