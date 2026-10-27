# The eta host and its web, in one image.
#
# docker build -f deploy/Dockerfile -t eta .
# docker run -d --name eta -p 8787:8787 -v eta-data:/data eta
#
# Build context: the repository root. The host runs from source (nothing in apps/eta is
# compiled) and the web is built. The LLM gateway's CLIProxyAPI binary comes with
# `bun install`, as the platform package of `@cpajs/cpa`.
ARG BUN_VERSION=1.4.3

FROM oven/bun:${BUN_VERSION} AS web
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run --cwd apps/web build

FROM oven/bun:${BUN_VERSION}
# The sessions' tools run bash and git; curl is for the healthcheck.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY --from=web /repo/apps/web/dist /srv/web

# The host and the sessions' bash run as the image's unprivileged `bun` user (uid 1000). /data is
# created and owned by it *before* the VOLUME line, so a fresh named volume inherits that
# ownership; a bind mount or a volume made by an older (root) image has to be chowned once:
# `docker run --rm -u 0 --entrypoint chown -v eta-data:/data eta -R 1000:1000 /data`.
RUN mkdir /data && chown bun:bun /data

# The one volume: the database, the session files, the agents' workspaces, the artifacts, the
# provider config, the LLM gateway's credentials and the access token all live under it, inside
# `.eta` — the host writes to `$HOME/.eta` and HOME is /data here, so the volume's contents are
# `/data/.eta/…`. A volume from before this (files straight in /data) needs one move:
# `docker run --rm -v eta-data:/data alpine sh -c 'mkdir -p /data/.eta && mv /data/* /data/.eta'`
VOLUME /data
USER bun
ENV HOME=/data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD curl -fsS http://127.0.0.1:8787/up || exit 1

# Listening beyond loopback turns the token gate on; the token is created in the data directory
# on first start (`docker exec eta cat /data/access-token`). Flags after the image name are
# appended: `docker run eta --allow-origin https://eta.example.com --memory-url http://memory:8320 --github`.
# Nothing GitHub is loaded unless `--github` (or ETA_GITHUB=1) is among them.
ENTRYPOINT ["bun", "apps/eta/src/main.ts", "--web-dir", "/srv/web", "--host", "0.0.0.0", "--port", "8787"]
