# Shared by deploy/nomad/deploy.sh and scripts/dev.sh (sourced).

# arch is this machine's, as images name it.
arch() {
  case "$(uname -m)" in
    x86_64 | amd64) echo amd64 ;;
    aarch64 | arm64) echo arm64 ;;
    *) echo "unsupported CPU architecture: $(uname -m)" >&2; return 1 ;;
  esac
}

# ensure_volume <namespace> <name> creates the host volume (a directory of
# this machine's, writable by any user, kept when what used it goes) unless
# the namespace has one of that name.
ensure_volume() {
  nomad volume status -namespace "$1" -type host 2>/dev/null | awk 'NR > 1 { print $2 }' | grep -qx "$2" && return 0
  nomad volume create - >/dev/null <<EOF
type      = "host"
name      = "$2"
namespace = "$1"
plugin_id = "mkdir"
capability {
  access_mode     = "single-node-writer"
  attachment_mode = "file-system"
}
parameters {
  mode = "0777"
}
EOF
  echo "Created the volume $2 in $1."
}

# wait_port <port> waits (up to a minute) until something accepts
# connections on loopback there: the infrastructure's tasks are running
# before they listen (PostgreSQL initializes its data directory first).
wait_port() {
  for _ in $(seq 1 120); do
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 0
    sleep 0.5
  done
  echo "nothing listens on 127.0.0.1:$1" >&2
  return 1
}
