#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: deploy/k3s/deploy.sh [--version TAG]

Deploys the working tree to the k3s cluster on this machine (deploy/k3s/README.md):
the infrastructure, AXP's images built by the cluster's BuildKit, the
database migrations, then AXP itself. With --version it deploys images
already in the registry (a rollback): nothing is built or migrated.

Needs k3s (with /etc/rancher/k3s/registries.yaml), bun, git and openssl.
Settings and secrets live in ~/.config/axp/production.env (generated once).
EOF
}

version=""
case "${1:-}" in
  -h | --help) usage; exit 0 ;;
  --version) version="${2:?--version needs a tag}" ;;
  "") ;;
  *) usage >&2; exit 1 ;;
esac

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
fail() { echo "deploy: $*" >&2; exit 1; }
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
for command in bun git kubectl openssl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
kubectl get --raw /readyz >/dev/null || fail "cannot reach the cluster (KUBECONFIG=$KUBECONFIG)."
grep -q '10.43.100.1:5000' /etc/rancher/k3s/registries.yaml 2>/dev/null ||
  fail "/etc/rancher/k3s/registries.yaml does not name the registry (deploy/k3s/README.md)."

REGISTRY=10.43.100.1:5000
export AXP_BUILDKIT=tcp://10.43.100.2:1234
CONFIG_DIR="${AXP_CONFIG_DIR:-$HOME/.config/axp}"
ENV_FILE="$CONFIG_DIR/production.env"

# --- Settings and secrets ----------------------------------------------------
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
ensure() {
  grep -q "^$1=" "$ENV_FILE" || { echo "$1=$2" >>"$ENV_FILE"; echo "Added $1 to $ENV_FILE."; }
}
ensure AXP_SECRET_KEY "$(openssl rand -hex 32)"
ensure POSTGRES_PASSWORD "$(openssl rand -hex 24)"
# OpenObserve wants upper and lower case letters, a digit and a symbol.
ensure AXP_OBSERVE_PASSWORD "Axp-$(openssl rand -hex 16)"
ensure AXP_S3_ACCESS_KEY_ID "$(openssl rand -hex 12)"
ensure AXP_S3_SECRET_ACCESS_KEY "$(openssl rand -hex 24)"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
observe_basic="$(printf '%s' "root@axp.local:$AXP_OBSERVE_PASSWORD" | base64 -w0)"

kubectl apply -f deploy/k3s/production/infra/namespace.yaml >/dev/null
secret() {
  kubectl -n axp create secret generic "$1" "${@:2}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
}
# The infrastructure's, and AXP's. An external S3 (AXP_S3_ENDPOINT) takes
# its own credentials; the built-in one shares them.
secret infra --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  --from-literal=AXP_S3_ACCESS_KEY_ID="$AXP_S3_ACCESS_KEY_ID" \
  --from-literal=AXP_S3_SECRET_ACCESS_KEY="$AXP_S3_SECRET_ACCESS_KEY" \
  --from-literal=AXP_OBSERVE_PASSWORD="$AXP_OBSERVE_PASSWORD" \
  --from-literal=OPENOBSERVE_AUTHORIZATION="Basic $observe_basic"
secret axp --from-literal=AXP_SECRET_KEY="$AXP_SECRET_KEY" \
  --from-literal=DATABASE_URL="postgres://axp:$POSTGRES_PASSWORD@postgres.axp.svc.cluster.local:5432/axp" \
  --from-literal=AXP_S3_ACCESS_KEY_ID="$AXP_S3_ACCESS_KEY_ID" \
  --from-literal=AXP_S3_SECRET_ACCESS_KEY="$AXP_S3_SECRET_ACCESS_KEY" \
  --from-literal=OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic%20$observe_basic"

# --- Infrastructure and images -------------------------------------------------
if [[ -z "$version" ]]; then
  version="$(git rev-parse --short=12 HEAD)"
  [[ -z "$(git status --porcelain)" ]] || version+="-dirty-$(date +%s)"
fi
# The infrastructure first: images are built by its BuildKit into its
# registry.
kubectl apply -k deploy/k3s/production/infra >/dev/null
kubectl -n axp rollout status deploy/registry deploy/buildkitd deploy/postgres --timeout=5m >/dev/null
sed 's/NAMESPACE/axp/g' deploy/k3s/workloads.yaml | kubectl apply -f - >/dev/null

if ! curl -sfI "http://$REGISTRY/v2/axp/manifests/$version" >/dev/null 2>&1 || [[ "$version" == *-dirty-* ]]; then
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "unsupported CPU architecture: $(uname -m)" ;;
  esac
  echo "Building $version."
  build() { AXP_IMAGE="$REGISTRY/$2" bunx turbo run "image:linux-$arch" --filter="$1" --output-logs=errors-only; }
  build //   "axp:$version"
  build @axp/agent-runtime "axp-agent-runtime:production"
  build @axp/memory-service "axp-memory:$version"
  build @axp/agenvo "axp-relay:$version"
fi

# --- AXP ---------------------------------------------------------------------------
kubectl -n axp create configmap axp --dry-run=client -o yaml \
  --from-literal=AXP_VERSION="$version" --from-literal=AXP_IMAGE_TAG="$version" \
  --from-literal=AXP_PUBLIC_URL="${AXP_PUBLIC_URL:-}" \
  --from-literal=AXP_S3_ENDPOINT="${AXP_S3_ENDPOINT:-http://s3.axp.svc.cluster.local:8333}" \
  --from-literal=AXP_S3_BUCKET="${AXP_S3_BUCKET:-axp-artifacts}" \
  --from-literal=AXP_S3_REGION="${AXP_S3_REGION:-us-east-1}" \
  --from-literal=OTEL_EXPORTER_OTLP_ENDPOINT=http://openobserve.axp.svc.cluster.local:5080/observe/api/default \
  --from-literal=OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production |
  kubectl apply -f - >/dev/null

# Migrations run with the new image before anything uses it; a failure
# leaves the running version as it is.
job="migrate-${version//[^a-z0-9]/-}"
job="${job:0:63}"
kubectl -n axp delete job "$job" --ignore-not-found >/dev/null
kubectl -n axp apply -f - >/dev/null <<EOF
apiVersion: batch/v1
kind: Job
metadata: { name: $job }
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 86400
  template:
    spec:
      restartPolicy: Never
      enableServiceLinks: false
      containers:
        - name: migrate
          image: $REGISTRY/axp:$version
          command: [axp-control-plane, migrate]
          envFrom: [{ configMapRef: { name: axp } }, { secretRef: { name: axp } }]
EOF
if ! kubectl -n axp wait --for=condition=complete "job/$job" --timeout=10m >/dev/null; then
  kubectl -n axp logs "job/$job" >&2 || true
  fail "the migrations failed; $version is not deployed."
fi

# The manifests name AXP's image `axp`; this deploys the version's.
kubectl kustomize deploy/k3s/production | sed "s#^\( *image:\) axp\$#\1 $REGISTRY/axp:$version#" | kubectl apply -f - >/dev/null
for d in gateway runtime-gateway web api routine-worker controller; do
  kubectl -n axp rollout status "deploy/$d" --timeout=5m >/dev/null || fail "$d did not become ready."
done
echo "Deployed $version."
