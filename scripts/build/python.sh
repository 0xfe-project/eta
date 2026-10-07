#!/usr/bin/env bash
# Installs the locked runtime dependencies of the uv project in the current
# directory as a flat site-packages tree for one target platform:
# scripts/build/python.sh <os> <arch>. Wheels only, so any host can build any
# platform; images copy the tree into the interpreter's site-packages.
set -euo pipefail
os="$1" arch="$2"
case "$arch" in
  amd64) platform=x86_64-manylinux_2_28 ;;
  arm64) platform=aarch64-manylinux_2_28 ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac
[[ "$os" == linux ]] || { echo "unsupported os: $os" >&2; exit 1; }
out="out/$os-$arch"
rm -rf "$out"
mkdir -p "$out"
uv export --frozen --no-dev --no-emit-project --quiet -o "$out/requirements.txt"
uv pip install --quiet --no-deps --only-binary :all: \
  --python-platform "$platform" --python-version "$(cat .python-version)" \
  --target "$out/site-packages" -r "$out/requirements.txt"
# Console scripts carry this host's interpreter path; images use `python -m`.
rm -rf "$out/site-packages/bin"
