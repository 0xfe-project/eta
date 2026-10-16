#!/usr/bin/env bash
# Builds an image from the per-platform artifacts of `build:<os>-<arch>`
# with this machine's Docker, where Nomad runs containers from (no registry):
# scripts/build/image.sh <app|runtime|memory|relay> <os> <arch>.
# Run through Turbo's image:<os>-<arch> tasks, which build those artifacts
# first and in parallel. AXP_IMAGE is the image to build.
#
#   app      deploy/Dockerfile: the gateways, web and the control plane
#   runtime  apps/agent-runtime (with vendor/akhook and axp-plugins from
#            packages/plugins-go), what agents' images are built on
#   memory   bundles/memory/service, the memory bundle's service
#   relay    apps/agenvo, the agenvo bundle's service
#
# Docker's build cache makes an unchanged image cost about a second, so
# Turbo never caches these tasks.
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/../.."
build=(--platform "$2/$3" --load --tag "${AXP_IMAGE:?set AXP_IMAGE}")
case "$1" in
  app) build+=(--file deploy/Dockerfile .) ;;
  runtime)
    # akhook is built from its submodule, which a fresh clone lacks.
    [[ -f vendor/akhook/Cargo.toml ]] || git submodule update --init vendor/akhook
    # Codex at the version the runtime's protocol types were generated from.
    codex="$(node -p 'require("./apps/agent-runtime/package.json").devDependencies["@openai/codex"]')"
    build+=(--build-arg "CODEX_VERSION=$codex"
      --build-context akhook-src=vendor/akhook
      --build-context plugins-tool=packages/plugins-go/out
      apps/agent-runtime) ;;
  memory) build+=(bundles/memory/service) ;;
  relay) build+=(apps/agenvo) ;;
  *) echo "unknown image: $1" >&2; exit 1 ;;
esac
docker buildx build --progress=quiet "${build[@]}"
