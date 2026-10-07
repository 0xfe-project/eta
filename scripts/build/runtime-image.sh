#!/usr/bin/env bash
# Builds the agent runtime image for this machine's architecture through
# Turbo, which restores or builds its site-packages first:
# scripts/build/runtime-image.sh <tag>.
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/../.."
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
esac
AXP_RUNTIME_IMAGE="$1" bunx turbo run "image:linux-$arch" \
  --filter=@axp/agent-runtime --output-logs=errors-only
