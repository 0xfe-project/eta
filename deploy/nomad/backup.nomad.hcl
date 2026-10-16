# Every night, a dump of every database (the control plane's, routines',
# bundles' services') to the volume backups, the last 7 kept. The other
# volumes (deploy/README.md) are copied off the machine by hand.
job "backup" {
  namespace = "axp"
  type      = "batch"

  periodic {
    crons            = ["0 4 * * *"]
    prohibit_overlap = true
  }

  group "backup" {
    network {
      mode = "host"
    }
    volume "backups" {
      type   = "host"
      source = "backups"
    }
    task "dump" {
      driver = "docker"
      config {
        image        = "pgvector/pgvector:pg17-trixie"
        network_mode = "host"
        command      = "sh"
        args = [
          "-c",
          "pg_dumpall -h 127.0.0.1 -p 24432 -U axp | gzip >/backups/axp-$(date +%F).sql.gz && ls -1t /backups/axp-*.sql.gz | tail -n +8 | xargs -r rm --",
        ]
      }
      template {
        data        = "{{ with nomadVar \"nomad/jobs\" }}PGPASSWORD={{ .POSTGRES_PASSWORD }}{{ end }}"
        destination = "secrets/env"
        env         = true
      }
      volume_mount {
        volume      = "backups"
        destination = "/backups"
      }
      # No Nomad log collection (a logmon and a docker_logger process per
      # task): docker logs reads the output.
      logs {
        disabled = true
      }
      resources {
        cpu    = 200
        memory = 256
      }
    }
  }
}
