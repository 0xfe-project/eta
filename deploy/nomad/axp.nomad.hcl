# AXP itself, in the namespace axp: the two gateways, web and the control
# plane's three processes, from the image axp:<version> (deploy/Dockerfile)
# in this machine's Docker. Every task listens on the host's network, on
# loopback but for the runtime gateway, and reads the variable
# nomad/jobs/axp (AXP_SECRET_KEY, DATABASE_URL, the S3's settings, the
# public address, SENTRY_DSN, AXP_VERSION, AXP_IMAGE_TAG) that deploy.sh
# writes. Bundles' services are jobs of their own in this namespace, run
# by the controller; agents' in axp-agents.

variable "version" {
  type = string
}

locals {
  image = "axp:${var.version}"
  # The namespace's settings, in every task's environment.
  env = <<-EOT
    {{ with nomadVar "nomad/jobs/axp" }}{{ range $k, $v := . }}{{ $k }}={{ $v }}
    {{ end }}{{ end }}
  EOT
  # Bundles' services (apps/gateway/Caddyfile), from Nomad's service
  # discovery: the name of the service the route matched to its address,
  # and the agenvo relay's.
  bundles = <<-EOT
    map {re.bundle.1} {bundle_upstream} {
    {{- range nomadServices }}{{ $name := .Name }}{{ with nomadService $name }}{{ with index . 0 }}
    	{{ $name }} {{ .Address }}:{{ .Port }}{{ end }}{{ end }}{{ end }}
    	default ""
    }
    vars relay_upstream "{{ with nomadService "agenvo" }}{{ with index . 0 }}{{ .Address }}:{{ .Port }}{{ end }}{{ end }}"
  EOT
}

job "axp" {
  namespace = "axp"

  meta {
    version = var.version
  }

  update {
    max_parallel     = 1
    min_healthy_time = "5s"
    healthy_deadline = "5m"
  }

  # Both gateways (apps/gateway): the browser's site on loopback, where the
  # host's Caddy (behind Cloudflare Access) proxies to it and nothing else
  # publishes AXP, and the runtime site, agents' and bundles' services' only
  # way in, where the bridge network reaches the host.
  group "gateway" {
    network {
      mode = "host"
      port "public" {
        static = 24180
      }
      port "runtime" {
        static = 24090
      }
    }
    task "caddy" {
      driver = "docker"
      config {
        image        = local.image
        network_mode = "host"
        command      = "caddy"
        args         = ["run", "--config", "/app/apps/gateway/Caddyfile"]
      }
      template {
        data          = local.bundles
        destination   = "local/bundles.caddy"
        change_mode   = "signal"
        change_signal = "SIGUSR1"
      }
      resources {
        cpu    = 100
        memory = 128
      }
    }
  }

  # The SPA and its assets; reached only through the gateway.
  group "web" {
    network {
      mode = "host"
      port "http" {
        static = 24003
      }
    }
    task "web" {
      driver = "docker"
      config {
        image        = local.image
        network_mode = "host"
        command      = "bun"
        args         = ["/app/apps/web/server.js"]
      }
      template {
        data        = local.env
        destination = "secrets/axp.env"
        env         = true
      }
      resources {
        cpu    = 100
        memory = 256
      }
    }
  }

  # Both APIs and the models, each API on its own listener: the public one
  # reached only by the gateway, the internal one by the runtime gateway,
  # the routine worker and the controller. The GitHub App's credentials
  # (forge) and the models' accounts (llm) are on its volumes, so one runs
  # at a time. Chat streams (SSE) reconnect with Last-Event-ID.
  group "api" {
    network {
      mode = "host"
      port "public" {
        static = 24000
      }
      port "internal" {
        static = 24001
      }
    }
    volume "forge" {
      type   = "host"
      source = "forge"
    }
    volume "llm" {
      type   = "host"
      source = "llm"
    }
    task "api" {
      driver = "docker"
      config {
        image        = local.image
        network_mode = "host"
        command      = "axp-control-plane"
        args         = ["serve"]
      }
      env {
        AXP_FORGE_STATE_DIR = "/app/var/forge"
        AXP_LLM_STATE_DIR   = "/app/var/llm"
      }
      template {
        data        = local.env
        destination = "secrets/axp.env"
        env         = true
      }
      volume_mount {
        volume      = "forge"
        destination = "/app/var/forge"
      }
      volume_mount {
        volume      = "llm"
        destination = "/app/var/llm"
      }
      kill_timeout = "5s"
      resources {
        cpu        = 500
        memory     = 512
        memory_max = 2048
      }
    }
  }

  # Routines' runs: takes their fires from NATS and runs each as an ADK
  # agent, and revises briefs from feedback. One at a time: a new one waits
  # for the old one's lock; the old one records its runs as interrupted
  # when it stops.
  group "routine-worker" {
    network {
      mode = "host"
    }
    task "routine-worker" {
      driver = "docker"
      config {
        image        = local.image
        network_mode = "host"
        command      = "axp-control-plane"
        args         = ["routine-worker"]
      }
      template {
        data        = local.env
        destination = "secrets/axp.env"
        env         = true
      }
      kill_timeout = "30s"
      resources {
        cpu        = 200
        memory     = 256
        memory_max = 2048
      }
    }
  }

  # Agents' runtimes (jobs in axp-agents, images built with this machine's
  # Docker, whose socket it has), bundles' services (jobs in axp),
  # delivering work and importing events. It holds a lock; a new one waits
  # until the old one stopped, which finishes the tick in progress.
  group "controller" {
    network {
      mode = "host"
    }
    task "controller" {
      driver = "docker"
      config {
        image        = local.image
        network_mode = "host"
        command      = "axp-control-plane"
        args         = ["controller"]
        volumes      = ["/var/run/docker.sock:/var/run/docker.sock"]
      }
      template {
        data        = local.env
        destination = "secrets/axp.env"
        env         = true
      }
      kill_timeout = "30s"
      resources {
        cpu        = 200
        memory     = 256
        memory_max = 2048
      }
    }
  }
}
