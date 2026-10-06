#!/bin/sh
# Mount the agent's S3 workspace before the runtime starts. The runtime refuses
# to report ready when an S3 workspace is not mounted.
set -eu

if [ "${AXP_WORKSPACE_BACKEND:-volume}" = "s3" ]; then
  : "${AXP_S3_BUCKET:?AXP_S3_BUCKET is required for the s3 workspace backend}"
  # Mount under /mnt: hosts with Ubuntu's fusermount3 AppArmor profile only
  # allow FUSE mounts there.
  export AXP_WORKSPACE_DIR=/mnt/workspace
  mkdir -p "$AXP_WORKSPACE_DIR"
  : "${AXP_S3_PREFIX:?AXP_S3_PREFIX is required for the s3 workspace backend}"
  export RCLONE_CONFIG_AXP_TYPE=s3
  export RCLONE_CONFIG_AXP_PROVIDER="${AXP_S3_PROVIDER:-Other}"
  export RCLONE_CONFIG_AXP_ENV_AUTH=true
  export RCLONE_CONFIG_AXP_ENDPOINT="${AXP_S3_ENDPOINT:-}"
  export RCLONE_CONFIG_AXP_REGION="${AXP_S3_REGION:-us-east-1}"
  rclone mkdir "axp:${AXP_S3_BUCKET}/${AXP_S3_PREFIX}"
  # A local VFS cache gives Codex normal POSIX semantics (rename, partial writes).
  rclone mount "axp:${AXP_S3_BUCKET}/${AXP_S3_PREFIX}" "$AXP_WORKSPACE_DIR" \
    --vfs-cache-mode full --dir-cache-time 5s --allow-non-empty --daemon \
    --cache-dir /state/rclone-cache
  for _ in $(seq 1 50); do
    mountpoint -q "$AXP_WORKSPACE_DIR" && break
    sleep 0.2
  done
fi

exec "$@"
