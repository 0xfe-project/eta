#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: deploy/k3s/migrate-from-kamal.sh

Moves a machine's production from Kamal (Docker) to k3s, once: stops the
Kamal containers (kept, not removed), copies every Docker volume into the
volume (PVC) that replaces it, deploys with deploy/k3s/deploy.sh, and moves
agents' memories into the memory bundle's database. The Docker volumes stay
as they were: going back is `docker start` (deploy/README.md).

AXP is down while it runs (the copy takes about as long as reading the
volumes). Run it from the commit to deploy, with ~/.config/axp/production.env.
EOF
}
case "${1:-}" in -h | --help) usage; exit 0 ;; "") ;; *) usage >&2; exit 1 ;; esac

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
fail() { echo "migrate: $*" >&2; exit 1; }
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
for command in docker kubectl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
docker volume inspect axp-postgres >/dev/null 2>&1 || fail "no Kamal production here (no volume axp-postgres)."
! kubectl -n axp get deploy api >/dev/null 2>&1 || fail "AXP already runs in k3s (namespace axp)."
# shellcheck disable=SC1091
source "${AXP_CONFIG_DIR:-$HOME/.config/axp}/production.env"

# Docker volume → namespace/PVC. Agents' volumes are named after them.
volumes=(
  axp-postgres:axp/postgres axp-nats:axp/nats axp-objects:axp/objects axp-openobserve:axp/openobserve
  axp-forge:axp/forge axp-llm:axp/llm axp-relay:axp-bundles/agenvo-relay
)
for volume in $(docker volume ls -q --filter name='^axp-agent-'); do
  volumes+=("$volume:axp-agents/agent-${volume#axp-agent-}")
done

# --- The volumes, before anything uses them ---------------------------------
kubectl apply -f deploy/k3s/production/infra/namespace.yaml >/dev/null
sed 's/NAMESPACE/axp/g' deploy/k3s/workloads.yaml | kubectl apply -f - >/dev/null
# AXP's claims as its manifests have them: the deploy then finds them made.
docs() { awk -v kind="$1" 'BEGIN { RS = "\n---\n" } $0 ~ "kind: " kind "\n" { print "---"; print }'; }
kubectl kustomize deploy/k3s/production | docs PersistentVolumeClaim | kubectl apply -f - >/dev/null
docs PersistentVolumeClaim <bundles/agenvo/service/relay.yaml |
  kubectl -n axp-bundles apply -f - >/dev/null
kubectl -n axp-bundles label pvc agenvo-relay axp.dev/bundle=agenvo --overwrite >/dev/null
for pair in "${volumes[@]}"; do
  [[ "$pair" == *:axp-agents/* ]] || continue
  name="${pair##*/}"
  kubectl -n axp-agents apply -f - >/dev/null <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: $name, labels: { axp.dev/agent: ${name#agent-} } }
spec:
  storageClassName: axp
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 10Gi } }
EOF
done

echo "Stopping Kamal's containers (they stay, stopped)."
docker ps -q --filter label=service=axp | xargs -r docker stop >/dev/null
docker ps -q --filter name='^axp-agent-' | xargs -r docker stop >/dev/null
docker stop kamal-proxy >/dev/null 2>&1 || true

# A pod per namespace mounting its claims (which binds them), to unpack into.
for namespace in axp axp-bundles axp-agents; do
  mounts="" claims=""
  for pair in "${volumes[@]}"; do
    target="${pair#*:}"
    [[ "${target%/*}" == "$namespace" ]] || continue
    claim="${target#*/}"
    mounts+="        - { name: $claim, mountPath: /to/$claim }"$'\n'
    claims+="    - { name: $claim, persistentVolumeClaim: { claimName: $claim } }"$'\n'
  done
  kubectl -n "$namespace" apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata: { name: migrate-from-kamal }
spec:
  restartPolicy: Never
  containers:
    - name: unpack
      image: busybox:1.37
      command: [sleep, "86400"]
      volumeMounts:
$mounts  volumes:
$claims
EOF
done
for namespace in axp axp-bundles axp-agents; do
  kubectl -n "$namespace" wait --for=condition=Ready pod/migrate-from-kamal --timeout=5m >/dev/null
done
for pair in "${volumes[@]}"; do
  target="${pair#*:}"
  echo "Copying ${pair%%:*} to $target."
  docker run --rm -v "${pair%%:*}:/from:ro" busybox:1.37 tar -C /from -cf - . |
    kubectl -n "${target%/*}" exec -i migrate-from-kamal -- tar -C "/to/${target#*/}" -xpf -
done
for namespace in axp axp-bundles axp-agents; do
  kubectl -n "$namespace" delete pod migrate-from-kamal --wait=true >/dev/null
done

# --- AXP --------------------------------------------------------------------------
bash deploy/k3s/deploy.sh

# Agents' memories were in the control plane's database; the memory bundle's
# service has its own now, which the controller made. Its table is replaced
# with theirs, then the service restarts on it.
echo "Moving agents' memories."
for _ in $(seq 1 120); do
  [[ "$(kubectl -n axp-bundles get bundleservice memory -o jsonpath='{.status.state}' 2>/dev/null)" == ready ]] && break
  sleep 5
done
psql() { kubectl -n axp exec -i deploy/postgres -- env PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -q -U axp "$@"; }
kubectl -n axp exec deploy/postgres -- env PGPASSWORD="$POSTGRES_PASSWORD" \
  pg_dump -U axp --no-owner --no-acl --clean --if-exists -t memories axp | psql -d axp_bundle_memory
psql -d axp_bundle_memory -c 'ALTER TABLE memories OWNER TO axp_bundle_memory'
kubectl -n axp-bundles rollout restart deploy/memory >/dev/null
echo "Done. The Docker volumes are kept; remove them once production has run well on k3s (deploy/README.md)."
