#!/usr/bin/env bash
# Builds an image from the per-platform artifacts of `build:<os>-<arch>`
# with the cluster's BuildKit daemon and pushes it to the cluster's
# registry: scripts/build/image.sh <app|runtime|memory|relay> <os> <arch>.
# Run through Turbo's image:<os>-<arch> tasks, which build those artifacts
# first and in parallel. AXP_BUILDKIT is the daemon (buildctl --addr),
# AXP_IMAGE the image to push.
#
#   app      deploy/Dockerfile: the gateways, web and the control plane
#   runtime  apps/agent-runtime (with vendor/akhook and axp-plugins from
#            packages/plugins-go), what agents' images are built on
#   memory   bundles/memory/service, the memory bundle's service
#   relay    apps/agenvo, the agenvo bundle's service
#
# BuildKit's cache makes an unchanged image cost about a second, so Turbo
# never caches these tasks.
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/../.."
build=(--frontend dockerfile.v0 --opt "platform=$2/$3"
  --output "type=image,name=${AXP_IMAGE:?set AXP_IMAGE},push=true,registry.insecure=true")
case "$1" in
  app) build+=(--local context=. --local dockerfile=deploy) ;;
  runtime)
    # akhook is built from its submodule, which a fresh clone lacks.
    [[ -f vendor/akhook/Cargo.toml ]] || git submodule update --init vendor/akhook
    # Codex at the version the runtime's protocol types were generated from.
    codex="$(node -p 'require("./apps/agent-runtime/package.json").devDependencies["@openai/codex"]')"
    build+=(--local context=apps/agent-runtime --local dockerfile=apps/agent-runtime
      --opt "build-arg:CODEX_VERSION=$codex"
      --local akhook-src=vendor/akhook --opt context:akhook-src=local:akhook-src
      --local plugins-tool=packages/plugins-go/out --opt context:plugins-tool=local:plugins-tool) ;;
  memory) build+=(--local context=bundles/memory/service --local dockerfile=bundles/memory/service) ;;
  relay) build+=(--local context=apps/agenvo --local dockerfile=apps/agenvo) ;;
  *) echo "unknown image: $1" >&2; exit 1 ;;
esac
"$(bash scripts/build/buildctl.sh)" --addr "${AXP_BUILDKIT:?set AXP_BUILDKIT}" build --progress=quiet "${build[@]}"
