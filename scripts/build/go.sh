#!/usr/bin/env bash
# Cross-compiles the Go module in the current directory for one target
# platform: scripts/build/go.sh <name> <os> <arch>. The output is reproducible
# (no paths, no VCS stamp), so Docker reuses its COPY layer while the binary is
# unchanged.
set -euo pipefail
name="$1" os="$2" arch="$3"
out="out/$os-$arch"
rm -rf "$out"
CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
  go build -trimpath -buildvcs=false -ldflags="-s -w" -o "$out/$name" .
