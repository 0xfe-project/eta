#!/usr/bin/env bash
# Builds the `axp` binary remote computers install, for every platform they
# may be, into apps/remote/out/dist/axp-<os>-<arch> (served at /remote/dl/).
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/../../apps/remote"
rm -rf out/dist
for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64; do
  os="${target%/*}" arch="${target#*/}"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
    go build -trimpath -buildvcs=false -ldflags="-s -w" -o "out/dist/axp-$os-$arch" .
done
