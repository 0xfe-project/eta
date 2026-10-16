#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: deploy/nomad/deploy.sh [--version TAG]

Deploys the working tree to the Nomad agent on this machine (deploy/README.md):
the infrastructure, AXP's images built with this machine's Docker (and the
web's source maps, uploaded to Rustrak), the database migrations, then AXP
itself. With --version it deploys images already in Docker (a rollback):
nothing is built or migrated.

Needs nomad (NOMAD_ADDR, the local agent by default), docker, bun, git and
openssl. Settings and secrets live in ~/.config/axp/production.env
(generated once).
EOF
}

version=""
rollback=""
case "${1:-}" in
  -h | --help) usage; exit 0 ;;
  --version) version="${2:?--version needs a tag}"; rollback=1 ;;
  "") ;;
  *) usage >&2; exit 1 ;;
esac

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
fail() { echo "deploy: $*" >&2; exit 1; }
for command in bun docker git nomad openssl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
nomad status >/dev/null 2>&1 || fail "cannot reach Nomad (NOMAD_ADDR=${NOMAD_ADDR:-http://127.0.0.1:4646}); see deploy/README.md."

CONFIG_DIR="${AXP_CONFIG_DIR:-$HOME/.config/axp}"
ENV_FILE="$CONFIG_DIR/production.env"
# shellcheck source=lib.sh
source deploy/nomad/lib.sh

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
ensure RUSTRAK_SESSION_SECRET_KEY "$(openssl rand -hex 32)"
ensure RUSTRAK_SUPERUSER "admin@axp.local:$(openssl rand -hex 12)"
# The built-in S3's credentials; an external S3 (AXP_S3_ENDPOINT) takes its own.
ensure AXP_S3_ACCESS_KEY_ID "axp"
ensure AXP_S3_SECRET_ACCESS_KEY "$(openssl rand -hex 24)"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# --- Infrastructure ------------------------------------------------------------
nomad namespace apply axp >/dev/null
nomad namespace apply axp-agents >/dev/null
# Agents reserve little memory and may use more (memory_max).
nomad operator scheduler set-config -memory-oversubscription=true >/dev/null
nomad var put -force -namespace axp nomad/jobs \
  POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  AXP_S3_ACCESS_KEY_ID="$AXP_S3_ACCESS_KEY_ID" AXP_S3_SECRET_ACCESS_KEY="$AXP_S3_SECRET_ACCESS_KEY" \
  RUSTRAK_SESSION_SECRET_KEY="$RUSTRAK_SESSION_SECRET_KEY" RUSTRAK_SUPERUSER="$RUSTRAK_SUPERUSER" >/dev/null
for volume in postgres nats objects rustrak backups forge llm; do
  ensure_volume axp "$volume"
done
nomad job run -var namespace=axp -var postgres_port=24432 -var nats_port=24222 -var s3_port=24333 -var rustrak_port=24080 \
  deploy/nomad/infra.nomad.hcl >/dev/null || fail "the infrastructure did not become ready."
for port in 24432 24222 24080; do
  wait_port "$port" || fail "the infrastructure did not become ready."
done

# Rustrak's project for AXP, and a token for the web's source maps, once.
export RUSTRAK_URL="http://127.0.0.1:24080"
grep -q '^SENTRY_DSN=' "$ENV_FILE" || ensure SENTRY_DSN "$(bun deploy/rustrak.ts dsn)"
grep -q '^RUSTRAK_TOKEN=' "$ENV_FILE" || ensure RUSTRAK_TOKEN "$(bun deploy/rustrak.ts token)"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# --- Images ----------------------------------------------------------------------
if [[ -z "$version" ]]; then
  version="$(git rev-parse --short=12 HEAD)"
  [[ -z "$(git status --porcelain)" ]] || version+="-dirty-$(date +%s)"
fi
if [[ -z "$rollback" ]]; then
  echo "Building $version."
  build() { AXP_IMAGE="$2" bunx turbo run "image:linux-$(arch)" --filter="$1" --output-logs=errors-only; }
  build //   "axp:$version"
  build @axp/agent-runtime "axp-agent-runtime:production"
  build @axp/memory-service "axp-memory:$version"
  build @axp/agenvo "axp-relay:$version"
  # Rustrak maps the browser's minified stacks back to the source with these
  # (by the debug ids the build gave each file). Errors still arrive
  # without them.
  SENTRY_URL="$RUSTRAK_URL" SENTRY_AUTH_TOKEN="$RUSTRAK_TOKEN" SENTRY_ORG=axp SENTRY_PROJECT=axp \
    bun run --cwd apps/web sourcemaps:upload >/dev/null ||
    echo "deploy: the web's source maps were not uploaded to Rustrak." >&2
fi

# --- AXP ---------------------------------------------------------------------------
nomad var put -force -namespace axp nomad/jobs/axp \
  AXP_SECRET_KEY="$AXP_SECRET_KEY" \
  DATABASE_URL="postgres://axp:$POSTGRES_PASSWORD@127.0.0.1:24432/axp" \
  AXP_VERSION="$version" AXP_IMAGE_TAG="$version" \
  AXP_PUBLIC_URL="${AXP_PUBLIC_URL:-}" \
  AXP_S3_ENDPOINT="${AXP_S3_ENDPOINT:-http://127.0.0.1:24333}" \
  AXP_S3_BUCKET="${AXP_S3_BUCKET:-axp-artifacts}" \
  AXP_S3_REGION="${AXP_S3_REGION:-us-east-1}" \
  AXP_S3_ACCESS_KEY_ID="$AXP_S3_ACCESS_KEY_ID" AXP_S3_SECRET_ACCESS_KEY="$AXP_S3_SECRET_ACCESS_KEY" \
  SENTRY_DSN="$SENTRY_DSN" SENTRY_ENVIRONMENT=production >/dev/null

# Migrations run with the new image before anything uses it; a failure
# leaves the running version as it is.
if [[ -z "$rollback" ]]; then
  docker run --rm --network host \
    -e DATABASE_URL="postgres://axp:$POSTGRES_PASSWORD@127.0.0.1:24432/axp" -e AXP_SECRET_KEY="$AXP_SECRET_KEY" \
    "axp:$version" axp-control-plane migrate || fail "the migrations failed; $version is not deployed."
fi

# nomad job run waits until the deployment succeeded.
nomad job run -var "version=$version" deploy/nomad/axp.nomad.hcl >/dev/null || fail "AXP did not become ready."
nomad job run deploy/nomad/backup.nomad.hcl >/dev/null
echo "Deployed $version."
