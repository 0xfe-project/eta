# Sourced by the development scripts.

# dev_container NAME IMAGE DOCKER_RUN_ARGS... -- COMMAND...
# Starts a per-machine container, recreating it (volumes kept) when its image
# or arguments change.
dev_container() {
  local name="$1" image="$2" hash
  shift 2
  hash="$(printf '%s\n' "$image" "$@" | sha256sum | cut -c1-12)"
  if [[ "$(docker inspect -f '{{index .Config.Labels "axp.config"}}' "$name" 2>/dev/null || true)" != "$hash" ]]; then
    docker rm -f "$name" >/dev/null 2>&1 || true
    local args=() command=()
    while [[ $# -gt 0 && "$1" != "--" ]]; do args+=("$1"); shift; done
    [[ $# -gt 0 ]] && shift
    command=("$@")
    docker run -d --name "$name" --restart unless-stopped --label "axp.config=$hash" \
      "${args[@]}" "$image" "${command[@]}" >/dev/null
  fi
  docker start "$name" >/dev/null
}
