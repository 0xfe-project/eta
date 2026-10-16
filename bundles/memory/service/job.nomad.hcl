# Agents' memories (axp_memory, next to this file): one for every agent, each
# reaching only its own (X-AXP-Agent-Id). Its database, its token for the
# models, the gateway's address and its DSN (the gateway's /sentry) are what
# AXP puts in its environment (docs/architecture/bundles.md#服务).
job "memory" {
  group "memory" {
    network {
      mode = "bridge"
    }
    # At its address on the bridge network: the gateways route to it, and
    # nothing is published on the host.
    service {
      name         = "memory"
      provider     = "nomad"
      port         = "8320"
      address_mode = "alloc"
      check {
        type         = "http"
        path         = "/up"
        port         = "8320"
        address_mode = "alloc"
        interval     = "5s"
        timeout      = "2s"
      }
    }
    task "memory" {
      driver = "docker"
      config {
        image = "axp-memory"
      }
      resources {
        cpu        = 200
        memory     = 512
        memory_max = 2048
      }
    }
  }
}
