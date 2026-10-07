#!/usr/bin/env bash
# Builds the agent runtime image for this machine's architecture from the
# Turbo-cached site-packages: scripts/build/runtime-image.sh <tag>.
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/../.."
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
esac
bunx turbo run "build:linux-$arch" --filter=@axp/agent-runtime --output-logs=errors-only
docker buildx build --load -q -t "$1" apps/agent-runtime >/dev/null
