#!/usr/bin/env bash
# Starts development's PostgreSQL (shared by every instance and the tests, kept
# running between sessions) and waits until it accepts connections. Its
# address is the control plane's default DATABASE_URL.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/dev-container.sh"

# Same major version as production's accessory.
dev_container axp-dev-postgres postgres:17 \
  -p 127.0.0.1:15432:5432 -v axp-dev-postgres:/var/lib/postgresql/data \
  -e POSTGRES_USER=axp -e POSTGRES_PASSWORD=axp -e POSTGRES_DB=axp
# Over TCP: the server initdb runs on first start listens on the socket only.
for _ in $(seq 1 60); do
  docker exec axp-dev-postgres pg_isready -q -h 127.0.0.1 -U axp -d axp && exit 0
  sleep 0.5
done
echo "axp-dev-postgres did not become ready" >&2
exit 1
