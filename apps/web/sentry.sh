#!/usr/bin/env bash
# Sentry's CLI (sentry sourcemap inject|upload) without state between runs:
# it would keep a server, defaults and credentials in its own directory,
# which then win over SENTRY_URL. Its telemetry and update checks are off.
set -euo pipefail
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
SENTRY_CONFIG_DIR="$dir" SENTRY_CLI_NO_TELEMETRY=1 SENTRY_CLI_NO_UPDATE_CHECK=1 sentry "$@"
