#!/usr/bin/env bash
# Builds agenvo from the commit apps/agenvo/package.json pins (the fork, so
# AXP need not wait for an upstream release) into apps/agenvo/out:
#   relay/    the relay (@agenvo/server and its production dependencies),
#             which apps/agenvo/Dockerfile copies (the agenvo bundle's service)
#   dist/     the connectors remote computers install, served at
#             /remote/dl/agenvo-<kind>-<version>.tgz
#   version   the version the relay and the connectors report: agenvo's own
#             plus +<commit>, so AXP tells them apart from npm releases
# The checkout stays in out/src for the next build.
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/../../apps/agenvo"
read -r repository commit < <(node -p 'const { agenvo } = require("./package.json"); `${agenvo.repository} ${agenvo.commit}`')
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "agenvo.commit must be a full commit SHA" >&2; exit 1; }

src=out/src
[[ -d "$src/.git" ]] || git init -q "$src"
if [[ "$(git -C "$src" rev-parse -q --verify HEAD || true)" != "$commit" ]]; then
  git -C "$src" fetch -q --depth 1 "$repository" "$commit"
fi
git -C "$src" checkout -q --force --detach "$commit"
[[ "$(git -C "$src" rev-parse HEAD)" == "$commit" ]]

version="$(node -p 'require("./out/src/packages/protocol/package.json").version')+${commit:0:12}"
node -e '
const fs = require("node:fs");
const [file, version] = process.argv.slice(1);
const before = fs.readFileSync(file, "utf8");
const after = before.replace(/export const VERSION = "[^"]*"/, `export const VERSION = ${JSON.stringify(version)}`);
if (after === before) throw new Error(`no VERSION in ${file}`);
fs.writeFileSync(file, after);
' "$src/packages/protocol/src/index.ts" "$version"

rm -rf out/relay out/dist out/version out/pack
mkdir -p out/relay out/dist out/pack
(
  cd "$src"
  npm ci --no-audit --no-fund --loglevel=error
  for app in server paseo herdr; do node scripts/build.mjs "$app"; done
  npm pack --silent --pack-destination ../pack \
    --workspace @agenvo/server --workspace @agenvo/paseo --workspace @agenvo/herdr >/dev/null
)
for kind in paseo herdr; do
  mv out/pack/agenvo-"$kind"-*.tgz "out/dist/agenvo-$kind-$version.tgz"
done
# The relay's dependencies resolve here; package-lock.json records them.
mv out/pack/agenvo-server-*.tgz out/relay/agenvo-server.tgz
echo '{"private": true}' >out/relay/package.json
(cd out/relay && npm install --omit=dev --no-audit --no-fund --loglevel=error ./agenvo-server.tgz)
rm -rf out/pack
echo "$version" >out/version
