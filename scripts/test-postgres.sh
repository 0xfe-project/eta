#!/usr/bin/env bash
# Starts the tests' PostgreSQL (shared by every checkout and CI, kept running
# between runs, in Docker) and waits until it accepts connections. Its
# address is the tests' default (packages/service-go/pg/pgtest).
set -euo pipefail

# The same image as production's: PostgreSQL 17 with pgvector.
name=axp-dev-postgres
image=pgvector/pgvector:pg17-trixie
args=(-p 127.0.0.1:15432:5432 -v axp-dev-postgres:/var/lib/postgresql/data
  -e POSTGRES_USER=axp -e POSTGRES_PASSWORD=axp -e POSTGRES_DB=axp)
# Serialize concurrent callers (e.g. service-go and control-plane tests).
if command -v flock >/dev/null 2>&1; then
  exec 9>"${TMPDIR:-/tmp}/axp-dev-postgres.lock"
  flock 9
fi
# Recreated (its volume kept) only when its image or arguments change.
hash="$(printf '%s\n' "$image" "${args[@]}" | sha256sum | cut -c1-12)"
state="$(docker inspect -f '{{.State.Running}} {{index .Config.Labels "axp.config"}}' "$name" 2>/dev/null || true)"
if [[ "$state" == "true $hash" ]] && docker exec "$name" pg_isready -q -h 127.0.0.1 -U axp -d axp 2>/dev/null; then
  exit 0
fi
if [[ "${state#* }" != "$hash" ]]; then
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --restart unless-stopped --label "axp.config=$hash" "${args[@]}" "$image" >/dev/null
else
  docker start "$name" >/dev/null
fi
# Over TCP: the server initdb runs on first start listens on the socket only.
for _ in $(seq 1 60); do
  docker exec "$name" pg_isready -q -h 127.0.0.1 -U axp -d axp && exit 0
  sleep 0.5
done
echo "$name did not become ready" >&2
exit 1
