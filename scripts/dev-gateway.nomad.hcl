# Development's gateway (scripts/dev.sh): the same Caddy configuration as
# production's two gateways (apps/gateway, copied to var/gateway with the
# HTTPS site), in one task on the host's network, in the instance's
# namespace with the bundles' services it routes to. The browser's site
# listens on PORT (loopback), the runtime gateway on PORT+5 (where the
# bridge network reaches the host), HTTPS on PORT+8.

variable "namespace" {
  type = string
}

variable "port" {
  type = number
}

variable "root" {
  type        = string
  description = "The checkout, whose var/gateway and var/relay are mounted."
}

variable "rustrak_port" {
  type = number
}

job "gateway" {
  namespace = var.namespace

  group "gateway" {
    network {
      mode = "host"
      port "http" {
        static = var.port
      }
      port "runtime" {
        static = var.port + 5
      }
      port "https" {
        static = var.port + 8
      }
    }
    task "caddy" {
      driver = "docker"
      config {
        image        = "caddy:2.11.7-alpine"
        network_mode = "host"
        command      = "caddy"
        args         = ["run", "--config", "/etc/axp-gateway/Caddyfile"]
        volumes = [
          "${var.root}/var/gateway:/etc/axp-gateway:ro",
          "${var.root}/var/relay:/etc/axp-tls:ro",
        ]
      }
      env {
        AXP_GATEWAY_BIND         = "127.0.0.1"
        AXP_GATEWAY_PORT         = var.port
        AXP_RUNTIME_GATEWAY_BIND = "0.0.0.0"
        AXP_RUNTIME_GATEWAY_PORT = var.port + 5
        AXP_PUBLIC_PORT          = var.port + 8
        AXP_UPSTREAM_WEB         = "127.0.0.1:${var.port + 3}"
        AXP_UPSTREAM_API         = "127.0.0.1:${var.port + 1}"
        AXP_UPSTREAM_INTERNAL    = "127.0.0.1:${var.port + 2}"
        AXP_UPSTREAM_SENTRY      = "127.0.0.1:${var.rustrak_port}"
      }
      # As in deploy/nomad/axp.nomad.hcl.
      template {
        data          = <<-EOT
          map {re.bundle.1} {bundle_upstream} {
          {{- range nomadServices }}{{ $name := .Name }}{{ with nomadService $name }}{{ with index . 0 }}
          	{{ $name }} {{ .Address }}:{{ .Port }}{{ end }}{{ end }}{{ end }}
          	default ""
          }
          vars relay_upstream "{{ with nomadService "agenvo" }}{{ with index . 0 }}{{ .Address }}:{{ .Port }}{{ end }}{{ end }}"
        EOT
        destination   = "local/bundles.caddy"
        change_mode   = "signal"
        change_signal = "SIGUSR1"
      }
      # No Nomad log collection (a logmon and a docker_logger process per
      # task): docker logs reads the output.
      logs {
        disabled = true
      }
      resources {
        cpu    = 100
        memory = 128
      }
    }
  }
}
