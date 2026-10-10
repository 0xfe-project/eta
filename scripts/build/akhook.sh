#!/usr/bin/env bash
# Builds akhook (vendor/akhook) for this machine into packages/akhook/out:
# the agent runtime's and the plugin loader's tests run its rules with it.
# The runtime image builds its own (apps/agent-runtime/Dockerfile).
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/../.."
# A fresh clone lacks the submodule.
[[ -f vendor/akhook/Cargo.toml ]] || git submodule update --init vendor/akhook
cargo build --release --locked --quiet --manifest-path vendor/akhook/Cargo.toml
mkdir -p packages/akhook/out
cp vendor/akhook/target/release/akhook packages/akhook/out/akhook
