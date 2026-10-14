#!/usr/bin/env bash
# Prints the path of buildctl at the version of deploy/k3s's BuildKit
# daemon, downloading it once into ~/.cache/axp/buildkit-<version>.
set -euo pipefail
version=v0.34.0
bin="${XDG_CACHE_HOME:-$HOME/.cache}/axp/buildkit-$version/buildctl"
if [[ ! -x "$bin" ]]; then
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) echo "unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "https://github.com/moby/buildkit/releases/download/$version/buildkit-$version.linux-$arch.tar.gz" |
    tar -xz -C "$tmp" bin/buildctl
  mkdir -p "$(dirname "$bin")"
  mv "$tmp/bin/buildctl" "$bin"
fi
echo "$bin"
