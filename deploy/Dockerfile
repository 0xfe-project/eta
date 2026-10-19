# The eta host and its web, in one image.
#
# docker build -f deploy/Dockerfile -t eta .
# docker run -d --name eta -p 8787:8787 -v eta-data:/data eta
#
# Build context: the repository root. The host runs from source (nothing in apps/eta is
# compiled); the web is built, and so is the LLM gateway, a Go library the host loads.
ARG BUN_VERSION=1.3.14
ARG GO_VERSION=1.26

FROM oven/bun:${BUN_VERSION} AS web
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run --cwd apps/web build

# The LLM gateway (packages/llm-gateway) as a C shared library. Built on the same base as the
# final image so that the library links against the glibc it will run with; Go itself is a static
# toolchain copied in, and cgo needs gcc. go.mod's toolchain line is fetched on demand.
FROM golang:${GO_VERSION} AS go
FROM oven/bun:${BUN_VERSION} AS gateway
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/*
COPY --from=go /usr/local/go /usr/local/go
ENV PATH=/usr/local/go/bin:$PATH GOTOOLCHAIN=auto GOFLAGS=-trimpath
WORKDIR /repo/packages/llm-gateway
COPY packages/llm-gateway/go.mod packages/llm-gateway/go.sum ./
RUN go mod download
COPY packages/llm-gateway ./
RUN go build -buildmode=c-shared -o lib/libllm-gateway.so ./ffi

FROM oven/bun:${BUN_VERSION}
# The sessions' tools run bash and git; curl is for the healthcheck.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY --from=web /repo/apps/web/dist /srv/web
COPY --from=gateway /repo/packages/llm-gateway/lib/libllm-gateway.so /repo/packages/llm-gateway/lib/libllm-gateway.so

# The host and the sessions' bash run as the image's unprivileged `bun` user (uid 1000). /data is
# created and owned by it *before* the VOLUME line, so a fresh named volume inherits that
# ownership; a bind mount or a volume made by an older (root) image has to be chowned once:
# `docker run --rm -u 0 --entrypoint chown -v eta-data:/data eta -R 1000:1000 /data`.
RUN mkdir /data && chown bun:bun /data

# The one volume: the database, the session files, the agents' workspaces, the artifacts, the
# provider config, the LLM gateway's credentials and the access token all live under it.
VOLUME /data
USER bun
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD curl -fsS http://127.0.0.1:8787/up || exit 1

# Listening beyond loopback turns the token gate on; the token is created in the data directory
# on first start (`docker exec eta cat /data/access-token`). Flags after the image name are
# appended: `docker run eta --allow-origin https://eta.example.com --memory-url http://memory:8320`.
ENTRYPOINT ["bun", "apps/eta/src/main.ts", "--data-dir", "/data", "--web-dir", "/srv/web", "--host", "0.0.0.0", "--port", "8787"]
