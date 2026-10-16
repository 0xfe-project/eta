# The Nomad agent on the machine AXP runs on (deploy/README.md): one agent,
# server and client, reachable on loopback only. Copy to /etc/nomad.d/.
data_dir  = "/var/lib/nomad"
bind_addr = "127.0.0.1"

advertise {
  http = "127.0.0.1"
  rpc  = "127.0.0.1"
  serf = "127.0.0.1"
}

server {
  enabled          = true
  bootstrap_expect = 1
}

client {
  enabled = true
  servers = ["127.0.0.1"]
  # The CNI plugins (bridge networking) are installed here.
  cni_path = "/opt/cni/bin"
}

plugin "docker" {
  config {
    # The controller builds agents' images with Docker's socket.
    volumes {
      enabled = true
    }
    # Images are built on this machine and not in any registry: Nomad
    # must not remove them when a task stops (the controller prunes
    # agents' images itself).
    gc {
      image = false
    }
  }
}
