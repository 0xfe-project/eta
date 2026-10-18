# The eta host and its web, in one image.
#
# docker build -f deploy/Dockerfile -t eta .
# docker run -d --name eta -p 8787:8787 -v eta-data:/data eta
#
# Build context: the repository root. The host runs from source (nothing in apps/eta is
# compiled); only the web is built.
ARG BUN_VERSION=1.3.14

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

# The one volume: the database, the session files, the agents' workspaces, the artifacts, the
# provider config and the access token all live under it.
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD curl -fsS http://127.0.0.1:8787/up || exit 1

# Listening beyond loopback turns the token gate on; the token is created in the data directory
# on first start (`docker exec eta cat /data/access-token`). Flags after the image name are
# appended: `docker run eta --allow-origin https://eta.example.com --memory-url http://memory:8320`.
ENTRYPOINT ["bun", "apps/eta/src/main.ts", "--data-dir", "/data", "--web-dir", "/srv/web", "--host", "0.0.0.0", "--port", "8787"]
