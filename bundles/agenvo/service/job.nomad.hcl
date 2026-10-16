# The agenvo relay (apps/agenvo) that remote computers' connectors pair with,
# public at AXP's address under /remote/relay (the gateway's route to the
# service agenvo); it authenticates devices itself. Its administrator secret
# is the one AXP derives for the bundle (AXP_BUNDLE_SECRET), which the
# control plane derives too to manage it. One process owns its SQLite state
# on the volume, which the controller creates (docs/architecture/bundles.md#服务).
job "agenvo" {
  group "relay" {
    network {
      mode = "bridge"
    }
    volume "home" {
      type   = "host"
      source = "agenvo-relay"
    }
    service {
      name         = "agenvo"
      provider     = "nomad"
      port         = "8080"
      address_mode = "alloc"
      check {
        type         = "tcp"
        port         = "8080"
        address_mode = "alloc"
        interval     = "5s"
        timeout      = "2s"
      }
    }
    task "relay" {
      driver = "docker"
      config {
        image      = "axp-relay"
        entrypoint = ["sh", "-c"]
        # No $${…} here: Nomad interpolates those in a task's config.
        args = [<<-SH
          url="$AXP_PUBLIC_URL"; [ -n "$url" ] || url=https://relay.invalid
          printf '{"baseUrl": "%s/remote/relay", "dataDir": "/home/node/data", "host": "0.0.0.0", "port": 8080, "trustedProxy": true}' "$url" >/tmp/relay.json &&
          AGENVO_ADMIN_SECRET="$AXP_BUNDLE_SECRET" exec node /opt/agenvo/node_modules/@agenvo/server/dist/cli.js serve --config /tmp/relay.json
        SH
        ]
      }
      volume_mount {
        volume      = "home"
        destination = "/home/node"
      }
      resources {
        cpu    = 100
        memory = 256
      }
    }
  }
}
