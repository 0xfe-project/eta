#!/usr/bin/env bash
# Builds akhook (vendor/akhook) for this machine, into
# vendor/akhook/target/release/akhook, where the agent runtime's and
# packages/plugins-go's hook tests look for it. The runtime image builds its
# own (apps/agent-runtime/Dockerfile).
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/../.."
# A fresh clone lacks the submodule.
[[ -f vendor/akhook/Cargo.toml ]] || git submodule update --init vendor/akhook
cargo build --release --locked --manifest-path vendor/akhook/Cargo.toml
