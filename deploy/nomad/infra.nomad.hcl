# What AXP runs on, the same in production (namespace axp, deploy.sh) and
# development (axp-dev, scripts/dev.sh): PostgreSQL, NATS, the S3 for
# artifacts and Rustrak (errors, logs and traces). Credentials come from the
# namespace's variable nomad/jobs (POSTGRES_PASSWORD, AXP_S3_ACCESS_KEY_ID,
# AXP_S3_SECRET_ACCESS_KEY, RUSTRAK_SESSION_SECRET_KEY, RUSTRAK_SUPERUSER);
# data is on host volumes named after each (deploy/README.md).
#
# PostgreSQL and NATS listen on the host's network, where the control
# plane (loopback), agents and bundles' services (the bridge network's
# gateway, 172.26.64.1) reach them. The S3 and Rustrak, which only the
# control plane and the gateways reach, are on the bridge network with a
# port published on the host: each of their images opens several ports.

variable "namespace" {
  type = string
}

variable "postgres_port" {
  type = number
}

variable "nats_port" {
  type = number
}

variable "s3_port" {
  type = number
}

variable "rustrak_port" {
  type = number
}

job "infra" {
  namespace = var.namespace

  update {
    max_parallel     = 1
    min_healthy_time = "5s"
    healthy_deadline = "5m"
  }

  # PostgreSQL 17 with pgvector, on Debian trixie like postgres:17, so a
  # data directory keeps its collation. The control plane's database (axp),
  # routines' (axp_routines) and bundles' services' (axp_bundle_<name>).
  group "postgres" {
    network {
      mode = "host"
      port "db" {
        static = var.postgres_port
      }
    }
    volume "data" {
      type   = "host"
      source = "postgres"
    }
    task "postgres" {
      driver = "docker"
      config {
        image        = "pgvector/pgvector:pg17-trixie"
        network_mode = "host"
        args         = ["-p", "${var.postgres_port}"]
      }
      env {
        POSTGRES_USER = "axp"
        POSTGRES_DB   = "axp"
      }
      template {
        data        = "{{ with nomadVar \"nomad/jobs\" }}POSTGRES_PASSWORD={{ .POSTGRES_PASSWORD }}{{ end }}"
        destination = "secrets/env"
        env         = true
      }
      volume_mount {
        volume      = "data"
        destination = "/var/lib/postgresql/data"
      }
      kill_timeout = "30s"
      resources {
        cpu        = 500
        memory     = 512
        memory_max = 4096
      }
    }
  }

  # NATS JetStream: runtimes publish their events here, and routines'
  # schedules live here. No authentication.
  group "nats" {
    network {
      mode = "host"
      port "client" {
        static = var.nats_port
      }
    }
    volume "data" {
      type   = "host"
      source = "nats"
    }
    task "nats" {
      driver = "docker"
      config {
        image        = "nats:2.14-alpine"
        network_mode = "host"
        args         = ["--jetstream", "--store_dir", "/data", "--port", "${var.nats_port}"]
      }
      volume_mount {
        volume      = "data"
        destination = "/data"
      }
      resources {
        cpu        = 200
        memory     = 256
        memory_max = 1024
      }
    }
  }

  # Artifacts' objects: SeaweedFS's S3 API, for the control plane alone.
  group "s3" {
    network {
      mode = "bridge"
      port "s3" {
        static = var.s3_port
        to     = 8333
      }
    }
    volume "data" {
      type   = "host"
      source = "objects"
    }
    task "seaweedfs" {
      driver = "docker"
      config {
        image = "chrislusf/seaweedfs:4.48"
        args  = ["mini", "-dir=/data"]
      }
      template {
        data        = "{{ with nomadVar \"nomad/jobs\" }}AWS_ACCESS_KEY_ID={{ .AXP_S3_ACCESS_KEY_ID }}\nAWS_SECRET_ACCESS_KEY={{ .AXP_S3_SECRET_ACCESS_KEY }}{{ end }}"
        destination = "secrets/env"
        env         = true
      }
      volume_mount {
        volume      = "data"
        destination = "/data"
      }
      resources {
        cpu        = 200
        memory     = 256
        memory_max = 2048
      }
    }
  }

  # Errors, logs and traces: Rustrak, a server for Sentry's protocol
  # (GPL-3.0; its official image, run as it is). AXP's processes send to it
  # with Sentry's SDKs, to the DSN of its project `axp`; the browser and
  # bundles' services through a gateway's /sentry, which passes on only
  # envelopes. Its dashboard wants an origin of its own and is behind no
  # gateway (deploy/README.md). PUBLIC_URL is the address in its DSNs.
  group "rustrak" {
    network {
      mode = "bridge"
      port "http" {
        static = var.rustrak_port
        to     = 8080
      }
    }
    volume "data" {
      type   = "host"
      source = "rustrak"
    }
    task "rustrak" {
      driver = "docker"
      config {
        image = "rustrak/rustrak-server:v0.16.4"
      }
      env {
        PUBLIC_URL = "http://127.0.0.1:${var.rustrak_port}"
        # No anonymous usage reports to the project.
        RUSTRAK_TELEMETRY = "off"
      }
      template {
        data        = "{{ with nomadVar \"nomad/jobs\" }}SESSION_SECRET_KEY={{ .RUSTRAK_SESSION_SECRET_KEY }}\nCREATE_SUPERUSER={{ .RUSTRAK_SUPERUSER }}{{ end }}"
        destination = "secrets/env"
        env         = true
      }
      volume_mount {
        volume      = "data"
        destination = "/data"
      }
      resources {
        cpu        = 200
        memory     = 256
        memory_max = 2048
      }
    }
  }
}
