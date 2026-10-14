# Production image for every Kamal role (gateway, runtime-gateway, web, api,
# controller, routine-worker, llm, memory); the roles differ only in their
# command. Build context is the repository root. Agents' images are
# built by the controller on apps/agent-runtime's.
#
# Nothing is compiled here: `bun run build` (Turbo) produces the artifacts for
# each target platform outside Docker, and this file only copies them. Each
# COPY layer is reused while its files are byte-identical.

# The plugins routine runs get (the routine target, docs/architecture/plugins.md):
# their setup scripts install what they run (grok-api) into /opt/axp/bin, with
# a download cache kept across builds.
FROM python:3.13-slim AS routine-plugins
ARG TARGETOS
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY apps/agent-runtime/plugins /opt/axp/plugins
COPY packages/plugins-go/out/${TARGETOS}-${TARGETARCH}/axp-plugins /usr/local/bin/
RUN --mount=type=cache,target=/var/cache/axp-plugins \
    axp-plugins setup routine /opt/axp/plugins /opt/axp/bin

FROM python:3.13-slim
ARG TARGETOS
ARG TARGETARCH
LABEL service="axp"
COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=caddy:2.11.7-alpine /usr/bin/caddy /usr/local/bin/caddy
# The controller builds agents' images through the host's Docker (BuildKit).
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:29-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
# Least to most frequently changing.
# The memory service's dependencies; its role puts them on PYTHONPATH. Then
# its embedding model.
COPY apps/memory-service/out/${TARGETOS}-${TARGETARCH}/site-packages/ /app/apps/memory-service/site-packages/
COPY apps/memory-service/out/models/ /app/apps/memory-service/models/
COPY apps/llm-gateway/out/${TARGETOS}-${TARGETARCH}/axp-llm-gateway /usr/local/bin/
COPY --from=routine-plugins /opt/axp/bin/ /usr/local/bin/
COPY apps/control-plane/out/${TARGETOS}-${TARGETARCH}/axp-control-plane /usr/local/bin/
# Self-contained server bundle plus client assets; no node_modules.
COPY apps/web/out/ /app/apps/web/
COPY apps/gateway/Caddyfile apps/gateway/*.caddy /app/apps/gateway/
COPY apps/memory-service/axp_memory /app/apps/memory-service/axp_memory/
# The bundles and plugins agents' images are built from; the plugins are
# also what routine runs get.
COPY apps/agent-runtime/bundles /app/apps/agent-runtime/bundles/
COPY apps/agent-runtime/plugins /app/apps/agent-runtime/plugins/
# What remote computers download from /remote/dl: the axp binaries and the
# agenvo connectors (where the control plane looks for them by default).
COPY apps/remote/out/dist/ /app/apps/remote/out/dist/
COPY apps/agenvo/out/dist/ /app/apps/agenvo/out/dist/
# The control plane finds them at ../agent-runtime/; the LLM gateway keeps
# its state under var/ here (deploy/deploy.yml).
WORKDIR /app/apps/control-plane

ENV PYTHONUNBUFFERED=1
EXPOSE 3000 8000 8001 8080 8090 8317 8320
CMD ["bun", "/app/apps/web/server.js"]
