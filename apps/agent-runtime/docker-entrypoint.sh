#!/bin/sh
# Mount the agent's workspace, a directory of the JuiceFS filesystem, before
# the runtime starts. JuiceFS keeps the S3 credentials in its metadata.
set -eu

: "${AXP_JUICEFS_META_URL:?AXP_JUICEFS_META_URL is required}"
: "${AXP_WORKSPACE_PATH:?AXP_WORKSPACE_PATH is required}"
mkdir -p "$AXP_WORKSPACE_DIR"
juicefs mount --background --subdir "$AXP_WORKSPACE_PATH" \
  --cache-dir /state/juicefs-cache --hide-internal --no-usage-report \
  --backup-meta 0 "$AXP_JUICEFS_META_URL" "$AXP_WORKSPACE_DIR"
# Agent code runs in this container; keep the metadata credentials from it.
unset AXP_JUICEFS_META_URL

exec "$@"
