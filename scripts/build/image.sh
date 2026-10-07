#!/usr/bin/env bash
# Builds an image from the per-platform artifacts of `build:<os>-<arch>`:
# scripts/build/image.sh <app|runtime> <os> <arch>. Run through Turbo's
# image:<os>-<arch> tasks, which build those artifacts first and in parallel.
#
#   app      deploy/Dockerfile, pushed to the registry as $AXP_APP_IMAGE
#   runtime  apps/agent-runtime, loaded into Docker as $AXP_RUNTIME_IMAGE
#
# Docker's layer cache makes an unchanged image cost about a second, so Turbo
# never caches these tasks.
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/../.."
platform="$2/$3"
case "$1" in
  app)
    docker buildx build -q --platform "$platform" --file deploy/Dockerfile \
      --output=type=registry -t "${AXP_APP_IMAGE:?set AXP_APP_IMAGE}" .
    ;;
  runtime)
    docker buildx build -q --platform "$platform" --load \
      -t "${AXP_RUNTIME_IMAGE:-axp-agent-runtime:dev}" apps/agent-runtime
    ;;
  *) echo "unknown image: $1" >&2; exit 1 ;;
esac >/dev/null
