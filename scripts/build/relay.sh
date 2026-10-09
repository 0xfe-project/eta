#!/usr/bin/env bash
# Builds agenvo (vendor/agenvo, pinned to our fork) for AXP, into
# apps/relay/out:
#
#   server/       the relay (@agenvo/server) with its production
#                 dependencies; the `relay` role runs it with Node
#   connectors/   the Paseo and Herdr connectors as npm tarballs, which
#                 remote computers download from /remote/dl/ and install
#
# Everything is JavaScript, so one build serves every platform.
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/../.."
root="$PWD"
out="$root/apps/relay/out"
# A fresh clone lacks the submodule.
[[ -f vendor/agenvo/package.json ]] || git submodule update --init vendor/agenvo
rm -rf "$out"
mkdir -p "$out/server" "$out/connectors"
packed="$(mktemp -d)"
trap 'rm -rf "$packed"' EXIT
(
  cd vendor/agenvo
  npm ci --no-audit --no-fund --loglevel=error
  npm pack --silent --pack-destination "$packed" \
    --workspace @agenvo/server --workspace @agenvo/paseo --workspace @agenvo/herdr >/dev/null
)
# Stable names: remote computers fetch them by name.
for name in paseo herdr; do
  mv "$packed"/agenvo-"$name"-*.tgz "$out/connectors/agenvo-$name.tgz"
done
(
  cd "$out/server"
  echo '{"private":true}' >package.json
  npm install --omit=dev --no-audit --no-fund --loglevel=error "$packed"/agenvo-server-*.tgz
)
