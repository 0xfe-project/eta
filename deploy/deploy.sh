#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: deploy/deploy.sh [KAMAL_COMMAND...]

Deploys the working tree to the machine this runs on with Kamal
(deploy/deploy.yml). Without arguments it runs `kamal setup` the first time and
`kamal deploy` afterwards. Anything else is passed to Kamal, for example:

  deploy/deploy.sh app logs -r api -f
  deploy/deploy.sh app details
  deploy/deploy.sh rollback <version>

Needs Linux, Docker usable without sudo, git, openssl and an SSH server on this
machine. See deploy/README.md.
EOF
}

case "${1:-}" in -h | --help) usage; exit 0 ;; esac

DEPLOY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname -- "$DEPLOY_DIR")"
cd "$ROOT_DIR"

fail() { echo "deploy: $*" >&2; exit 1; }

[[ "$(uname -s)" == "Linux" ]] || fail "the deploy target must be Linux (this is $(uname -s))."
for command in bun docker git openssl ssh ssh-keygen; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
docker info >/dev/null 2>&1 || fail "cannot talk to Docker; is it running and is $(id -un) in the docker group?"

KAMAL_IMAGE="ghcr.io/basecamp/kamal:v2.12.0"
OBSERVE_USER=root@axp.local
CONFIG_DIR="${AXP_CONFIG_DIR:-$HOME/.config/axp}"
ENV_FILE="$CONFIG_DIR/production.env"
KEY_FILE="$CONFIG_DIR/kamal_ed25519"
REGISTRY_CONTAINER=axp-registry
RUNTIME_NETWORK=axp-prod-runtime

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

# --- Per-machine secrets and settings ----------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  (
    umask 077
    cat >"$ENV_FILE" <<EOF
# AXP production settings for deploy/deploy.sh on this machine. Keep private.
AXP_SECRET_KEY=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
# The local registry has no auth; Kamal still requires a password.
KAMAL_REGISTRY_PASSWORD=local
# AXP_PUBLIC_HOST=axp.example.com
AXP_PROXY_BIND=127.0.0.1
# AXP_SSH_PORT=22
EOF
  )
  echo "Created $ENV_FILE with fresh secrets."
fi
# Secrets added after a machine was set up are generated on the next deploy.
ensure_secret() {
  if ! grep -q "^$1=" "$ENV_FILE"; then
    echo "$1=$(openssl rand -hex "$2")" >>"$ENV_FILE"
    echo "Added $1 to $ENV_FILE."
  fi
}
# The control plane's key had Django's name; runtime tokens and cursors are
# derived from it, so a machine set up before keeps its value.
if ! grep -q "^AXP_SECRET_KEY=" "$ENV_FILE"; then
  old_key="$(sed -n 's/^DJANGO_SECRET_KEY=//p' "$ENV_FILE")"
  echo "AXP_SECRET_KEY=${old_key:-$(openssl rand -hex 32)}" >>"$ENV_FILE"
  echo "Added AXP_SECRET_KEY to $ENV_FILE."
fi
ensure_secret AXP_S3_SECRET_ACCESS_KEY 32
# OpenObserve requires upper and lower case letters, a digit and a symbol.
if ! grep -q "^AXP_OBSERVE_PASSWORD=" "$ENV_FILE"; then
  echo "AXP_OBSERVE_PASSWORD=Axp-$(openssl rand -hex 16)" >>"$ENV_FILE"
  echo "Added AXP_OBSERVE_PASSWORD to $ENV_FILE."
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
# Loaded last so the reserved production ports always win.
source "$DEPLOY_DIR/ports.env"
set +a
export AXP_DEPLOY_USER="${AXP_DEPLOY_USER:-$(id -un)}"
# Services send OTLP to OpenObserve as its root user (deploy/secrets).
AXP_OBSERVE_BASIC="$(printf '%s' "$OBSERVE_USER:$AXP_OBSERVE_PASSWORD" | base64 -w0)"
export AXP_OBSERVE_BASIC
export AXP_SSH_PORT="${AXP_SSH_PORT:-22}"
case "$(uname -m)" in
  x86_64 | amd64) export AXP_BUILD_ARCH=amd64 ;;
  aarch64 | arm64) export AXP_BUILD_ARCH=arm64 ;;
  *) fail "unsupported CPU architecture: $(uname -m)" ;;
esac

# --- SSH from the Kamal container back to this machine -------------------------
# A dedicated key, accepted only from loopback.
if [[ ! -f "$KEY_FILE" ]]; then
  ssh-keygen -q -t ed25519 -N "" -C "axp-kamal@$(hostname)" -f "$KEY_FILE"
fi
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
public_key="$(cut -d' ' -f1,2 "$KEY_FILE.pub")"
if ! grep -qF "$public_key" "$HOME/.ssh/authorized_keys" 2>/dev/null; then
  echo "from=\"127.0.0.1,::1\" $(cat "$KEY_FILE.pub")" >>"$HOME/.ssh/authorized_keys"
  chmod 600 "$HOME/.ssh/authorized_keys"
  echo "Authorized $KEY_FILE.pub for loopback SSH."
fi
ssh -i "$KEY_FILE" -p "$AXP_SSH_PORT" -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  -o ConnectTimeout=5 "$AXP_DEPLOY_USER@127.0.0.1" true ||
  fail "cannot SSH to $AXP_DEPLOY_USER@127.0.0.1:$AXP_SSH_PORT with $KEY_FILE; Kamal needs a running sshd that accepts public keys."

# --- Machine prerequisites ------------------------------------------------------
# Reserved ports must be free unless our own containers hold them.
ours="$(docker ps --filter name='^(kamal-proxy|axp-registry|axp-openobserve)$' --format '{{.Ports}}')"
for port in "$AXP_PROD_HTTP_PORT" "$AXP_PROD_HTTPS_PORT" "$AXP_PROD_REGISTRY_PORT" "$AXP_PROD_OBSERVE_PORT"; do
  if [[ "$ours" != *":$port->"* ]] && ss -Htln "sport = :$port" 2>/dev/null | grep -q .; then
    fail "port $port (deploy/ports.env) is taken by another service on this machine."
  fi
done

registry_binding="$(docker container inspect -f '{{(index (index .HostConfig.PortBindings "5000/tcp") 0).HostPort}}' "$REGISTRY_CONTAINER" 2>/dev/null || true)"
if [[ -n "$registry_binding" && "$registry_binding" != "$AXP_PROD_REGISTRY_PORT" ]]; then
  docker rm -f "$REGISTRY_CONTAINER" >/dev/null # moved port; images live in the volume
fi
if ! docker container inspect "$REGISTRY_CONTAINER" >/dev/null 2>&1; then
  docker run -d --name "$REGISTRY_CONTAINER" --restart unless-stopped \
    -p "127.0.0.1:$AXP_PROD_REGISTRY_PORT:5000" -v axp-registry:/var/lib/registry registry:3 >/dev/null
fi
docker start "$REGISTRY_CONTAINER" >/dev/null

# Runtimes' network; the runtime gateway attaches to it on boot. Docker picks a
# subnet that is free on this machine.
if ! docker network inspect "$RUNTIME_NETWORK" >/dev/null 2>&1; then
  docker network create --driver bridge --label dev.axp.runtime=network \
    "$RUNTIME_NETWORK" >/dev/null
fi

# Images are built from the working tree, so uncommitted changes ship too.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Warning: deploying uncommitted changes on top of $(git rev-parse --short HEAD)." >&2
fi

# --- Kamal ----------------------------------------------------------------------
if [[ $# -eq 0 ]]; then
  if docker container inspect axp-postgres >/dev/null 2>&1; then
    set -- deploy
  else
    set -- setup
  fi
fi

# The repository is mounted at its host path; a worktree also needs the shared
# git directory.
mounts=(-v "$ROOT_DIR:$ROOT_DIR")
git_common_dir="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
if [[ "$git_common_dir" != "$ROOT_DIR"/* ]]; then
  mounts+=(-v "$git_common_dir:$git_common_dir")
fi
tty_flags=(-i)
[[ -t 0 && -t 1 ]] && tty_flags=(-it)

kamal() {
  docker run --rm "${tty_flags[@]}" --network host \
    "${mounts[@]}" -w "$ROOT_DIR" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$KEY_FILE:/kamal/ssh/id_ed25519:ro" \
    --env-file "$ENV_FILE" \
    -e AXP_DEPLOY_USER -e AXP_SSH_PORT -e AXP_BUILD_ARCH \
    -e AXP_PROD_HTTP_PORT -e AXP_PROD_HTTPS_PORT -e AXP_PROD_REGISTRY_PORT \
    -e AXP_PROD_OBSERVE_PORT -e AXP_OBSERVE_BASIC \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$KAMAL_IMAGE" "$@" -c deploy/deploy.yml
}

# `kamal setup` boots every accessory; on machines set up before one was
# added, boot it before the first deploy that uses it. The collector holds no
# state and is rebooted on every deploy so config changes take effect.
prepare_accessories() {
  docker container inspect axp-s3 >/dev/null 2>&1 || kamal accessory boot s3
  docker container inspect axp-nats >/dev/null 2>&1 || kamal accessory boot nats
  if ! docker container inspect axp-openobserve >/dev/null 2>&1; then
    kamal accessory boot openobserve
  elif ! docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' axp-openobserve | grep -qx 'ZO_BASE_URI=/observe'; then
    # Booted before it moved under /observe; its data stays in the volume.
    kamal accessory reboot openobserve
  fi
  if docker container inspect axp-otel-collector >/dev/null 2>&1; then
    kamal accessory reboot otel-collector
  else
    kamal accessory boot otel-collector
  fi
}

# The postgres accessory's image (deploy/deploy.yml). Kamal keeps a running
# accessory on its old image, so a changed one is rebooted onto the new image
# (the data stays in the volume) before migrations run.
POSTGRES_IMAGE=pgvector/pgvector:pg17-trixie
update_postgres() {
  local current
  current="$(docker inspect -f '{{.Config.Image}}' axp-postgres 2>/dev/null || true)"
  if [[ -n "$current" && "$current" != "$POSTGRES_IMAGE" ]]; then
    kamal accessory reboot postgres
  fi
}

migrate() {
  kamal app exec --roles api --version "$version" --quiet \
    "axp-control-plane migrate"
}

if [[ "$1" == "setup" || "$1" == "deploy" ]]; then
  docker buildx version >/dev/null 2>&1 || fail "missing docker buildx (the images need BuildKit)."
  # Kamal deploys the image Turbo builds and pushes, under this version.
  version="$(git rev-parse HEAD)"
  [[ -z "$(git status --porcelain)" ]] || version+="_uncommitted_$(openssl rand -hex 8)"
  app_image="127.0.0.1:$AXP_PROD_REGISTRY_PORT/axp:$version"

  # Accessories need no build: prepare them meanwhile, without the terminal.
  if [[ "$1" == "deploy" ]]; then
    update_postgres
    accessories_log="$(mktemp)"
    trap 'rm -f "$accessories_log"' EXIT
    (tty_flags=() && prepare_accessories) </dev/null >"$accessories_log" 2>&1 &
    accessories_pid=$!
  fi

  # One Turbo run builds (or restores) every artifact in parallel, then each
  # image as soon as its own artifacts are ready.
  AXP_APP_IMAGE="$app_image" AXP_RUNTIME_IMAGE=axp-agent-runtime:production \
    bunx turbo run "image:linux-$AXP_BUILD_ARCH" --output-logs=errors-only
  echo "Built $app_image and axp-agent-runtime:production."

  if [[ "$1" == "deploy" ]]; then
    # Migrate before the roles boot together, so none runs on an old schema.
    # Unlike the accessories, this takes no deploy lock: it runs alongside.
    migrate
    if ! wait "$accessories_pid"; then
      cat "$accessories_log" >&2
      fail "preparing the accessories failed."
    fi
    echo "Accessories ready."
  fi
  command="$1"
  kamal "$command" --skip-push --version "$version" "${@:2}"
  # A first setup has no database until Kamal boots it.
  [[ "$command" == "deploy" ]] || migrate
else
  kamal "$@"
fi
