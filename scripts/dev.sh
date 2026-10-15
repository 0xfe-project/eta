#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/dev.sh [--port PORT]

Starts the development stack. AXP's processes run here, from this checkout:
the gateways (PORT, open this one, and the runtime gateway PORT+5), the
control plane's public API PORT+1 and internal API PORT+2 (one process), its
controller and routine worker, and web PORT+3. PORT+8 serves the gateway
over HTTPS (a self-signed certificate in var/relay), AXP's public address
for remote computers and the agenvo relay. The other ports of the block are
spare.

  --port PORT   Use exactly this gateway port; fail if any port of its block is taken.
                Also settable as AXP_DEV_PORT.

Without --port the default is 3000. When that block is taken (another checkout,
worktree or agent is running) the next free block in steps of 10 is used, so
any number of instances can start in parallel.

What runs in Kubernetes runs in this machine's k3s cluster (deploy/k3s/README.md),
as in production: the infrastructure in the namespace axp-dev, shared by every
instance and kept running (deploy/k3s/dev), and per database (DATABASE_URL's,
axp by default) agents' runtimes in dev-<database>-agents and bundles' services
(the memory, the agenvo relay) in dev-<database>-bundles, from images this
checkout builds.
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

fail() { echo "dev: $*" >&2; exit 1; }
for command in bun node uv go docker kubectl openssl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
kubectl get --raw /readyz >/dev/null 2>&1 || fail "cannot reach the k3s cluster (KUBECONFIG=$KUBECONFIG); see deploy/k3s/README.md."
grep -q '10.43.100.11:5000' /etc/rancher/k3s/registries.yaml 2>/dev/null ||
  fail "/etc/rancher/k3s/registries.yaml does not name development's registry (deploy/k3s/README.md)."
# Development settings: the cluster's DNS and development's services
# (internal/config).
export AXP_DEV=true
export AXP_BUILDKIT=tcp://10.43.100.12:1234
registry=10.43.100.11:5000

# Fresh checkouts and worktrees bootstrap themselves.
if [[ ! -f node_modules/concurrently/dist/bin/concurrently.js ]]; then
  bun install
fi
# The GitHub App's credentials and the models' accounts moved into the
# control plane (#241, #245); a checkout connected before keeps them.
for moved in apps/forge-service/var/forge:apps/control-plane/var/forge \
  apps/llm-gateway/var/llm-gateway:apps/control-plane/var/llm-gateway; do
  if [[ -d "${moved%%:*}" && ! -e "${moved##*:}" ]]; then
    mkdir -p "$(dirname "${moved##*:}")"
    mv "${moved%%:*}" "${moved##*:}"
  fi
done

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

port_listening() { [[ -n "$(ss -Htln "sport = :$1" 2>/dev/null)" ]]; }

port_reserved() {
  local file="$STATE_DIR/$1.pid" pid
  [[ -f "$file" ]] || return 1
  pid="$(<"$file")"
  [[ "$pid" != "$$" ]] && kill -0 "$pid" 2>/dev/null
}

# Production's gateway port is never used, even when it happens to be free.
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
# The processes listen on loopback, which pods cannot reach; the runtime
# gateway alone listens on the node's address on the pods' network (cni0).
# As in production, the browser and agents (and bundles' services) each
# reach AXP only through their gateway (apps/gateway).
export AXP_GATEWAY_BIND=127.0.0.1
export AXP_RUNTIME_GATEWAY_BIND=10.42.0.1
export AXP_RUNTIME_GATEWAY_URL="http://$AXP_RUNTIME_GATEWAY_BIND:$AXP_RUNTIME_GATEWAY_PORT"
export AXP_LLM_GATEWAY_URL="http://127.0.0.1:$AXP_INTERNAL_PORT"
export AXP_UPSTREAM_WEB="127.0.0.1:$AXP_WEB_PORT"
export AXP_UPSTREAM_API="127.0.0.1:$AXP_API_PORT"
export AXP_UPSTREAM_INTERNAL="127.0.0.1:$AXP_INTERNAL_PORT"
# Remote computers, and the relay (which takes only an HTTPS base URL),
# reach this instance at its HTTPS address.
export AXP_PUBLIC_URL="https://localhost:$AXP_PUBLIC_PORT"

# --- Kubernetes ---------------------------------------------------------------
# The shared infrastructure, then this database's namespaces.
kubectl apply -k deploy/k3s/dev >/dev/null
kubectl -n axp-dev rollout status deploy/postgres deploy/registry deploy/buildkitd deploy/nats deploy/rustrak --timeout=5m >/dev/null
# Rustrak replaced OpenObserve and the OpenTelemetry Collector (#141).
kubectl -n axp-dev delete deploy/openobserve svc/openobserve deploy/otel-collector svc/otel-collector \
  --ignore-not-found >/dev/null
kubectl -n axp-dev get configmap -o name | grep '^configmap/otel-collector-' | xargs -r kubectl -n axp-dev delete >/dev/null
database="${DATABASE_URL:-postgres://axp:axp@postgres.axp-dev.svc.cluster.local:5432/axp}"
database="${database##*/}"
database="${database%%\?*}"
export AXP_NAMESPACE="dev-${database//_/-}"
export AXP_BUNDLES_NAMESPACE="$AXP_NAMESPACE-bundles"
sed "s/NAMESPACE/$AXP_NAMESPACE/g" deploy/k3s/workloads.yaml | kubectl apply -f - >/dev/null
go -C apps/control-plane run . migrate

# This checkout's images, rebuilt on every start so they are never stale;
# BuildKit's cache makes an unchanged one cost about a second. Agents'
# images build on the runtime's, and bundles' services run AXP's own images
# at this tag, so worktrees never overwrite each other's: whichever
# controller runs moves agents and services onto its own.
export AXP_IMAGE_TAG="dev-$(printf '%s' "$ROOT_DIR" | sha256sum | cut -c1-8)"
export AXP_RUNTIME_IMAGE="$registry/axp-agent-runtime:$AXP_IMAGE_TAG"
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "unsupported CPU architecture: $(uname -m)" ;;
esac
image() { AXP_IMAGE="$registry/$2:$AXP_IMAGE_TAG" bunx turbo run "image:linux-$arch" --filter="$1" --output-logs=errors-only; }
image @axp/agent-runtime axp-agent-runtime
image @axp/memory-service axp-memory
image @axp/agenvo axp-relay
# The web client's types from the control plane's OpenAPI document, and what
# remote computers download (/remote/dl).
bunx turbo run generate --filter=@axp/web --output-logs=errors-only
bunx turbo run build --filter=@axp/remote --output-logs=errors-only

# --- HTTPS ------------------------------------------------------------------------
# A self-signed certificate for localhost, which connectors on this machine
# trust through NODE_EXTRA_CA_CERTS (`axp setup --ca-file var/relay/cert.pem`).
# When this instance's port changes, running `axp setup` again moves paired
# connectors to it.
tls_dir="$ROOT_DIR/var/relay"
mkdir -p "$tls_dir"
chmod 700 "$tls_dir"
if [[ ! -f "$tls_dir/cert.pem" ]]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
    -keyout "$tls_dir/key.pem" -out "$tls_dir/cert.pem" -subj /CN=localhost \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null
fi
chmod 644 "$tls_dir/key.pem"

# --- Errors, logs and traces ---------------------------------------------------------
# Development's Rustrak (dev-only credentials, deploy/k3s/dev), at a fixed
# address on this machine; every instance sends to its project axp, each as
# an environment of its own. The browser and bundles' services send through
# the gateways' /sentry.
rustrak=10.43.100.13:8080
rustrak_admin=admin@axp.local:axp-dev-rustrak
export AXP_UPSTREAM_SENTRY="$rustrak"
SENTRY_DSN="$(RUSTRAK_URL="http://$rustrak" RUSTRAK_SUPERUSER="$rustrak_admin" bun deploy/k3s/rustrak.ts dsn)" ||
  fail "cannot get the DSN from Rustrak at http://$rustrak."
export SENTRY_DSN SENTRY_ENVIRONMENT="development-$web_port"
exec 9>&-

cat <<EOF
AXP dev in $ROOT_DIR
  Web:      http://localhost:$AXP_GATEWAY_PORT
  API:      http://localhost:$AXP_GATEWAY_PORT/api/health
  Internal: http://127.0.0.1:$AXP_INTERNAL_PORT/internal/docs
  Rustrak:  http://$rustrak (${rustrak_admin%%:*} / ${rustrak_admin#*:}), environment $SENTRY_ENVIRONMENT
  DSN:      $SENTRY_DSN (this machine's)
  Public:   $AXP_PUBLIC_URL (remote computers trust $tls_dir/cert.pem)
  Cluster:  kubectl get pods,bundleservices -n $AXP_NAMESPACE-agents -n $AXP_BUNDLES_NAMESPACE
EOF

# Both gateways (production's two Deployments) in one Caddy on the host
# network, so it binds the addresses above, with an HTTPS site of its own in
# front of the browser's; the configuration is copied from this checkout.
gateway=axp-dev-gateway-$web_port
docker rm -f "$gateway" >/dev/null 2>&1 || true
rm -rf var/gateway
cp -r apps/gateway var/gateway
cp scripts/dev-https.caddy var/gateway/
gateway_env=""
for name in AXP_GATEWAY_BIND AXP_GATEWAY_PORT AXP_RUNTIME_GATEWAY_BIND AXP_RUNTIME_GATEWAY_PORT AXP_PUBLIC_PORT \
  AXP_UPSTREAM_WEB AXP_UPSTREAM_API AXP_UPSTREAM_INTERNAL AXP_UPSTREAM_SENTRY AXP_BUNDLES_NAMESPACE; do
  gateway_env+=" -e $name"
done

# Every process stops on Ctrl+C or when any of them exits.
exec node node_modules/concurrently/dist/bin/concurrently.js --kill-others \
  --names gateway,control-plane,controller,routine-worker,web \
  --prefix-colors gray,blue,cyan,yellow,green \
  "docker run --rm --name $gateway --network host$gateway_env -v $ROOT_DIR/var/gateway:/etc/axp-gateway:ro -v $tls_dir:/etc/axp-tls:ro caddy:2.11.7-alpine caddy run --config /etc/axp-gateway/Caddyfile" \
  "bun run dev:control-plane" \
  "PATH=$(dirname "$(bash scripts/build/buildctl.sh)"):\$PATH bun run dev:controller" \
  "bun run dev:routine-worker" \
  "bun run dev:web"
