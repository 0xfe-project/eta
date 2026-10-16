# Production image for AXP's own tasks (deploy/nomad/axp.nomad.hcl: gateway,
# runtime-gateway, web, api, controller, routine-worker); they differ only in
# their command. Build context is the repository root. Agents' images are
# built by the controller on apps/agent-runtime's, bundles' services from
# their own (scripts/build/image.sh).
#
# Nothing is compiled here: `bun run build` (Turbo) produces the artifacts for
# each target platform outside Docker, and this file only copies them. Each
# COPY layer is reused while its files are byte-identical.

# The plugins routine runs get (the routine target, docs/architecture/plugins.md):
# their setup scripts install what they run (grok-api) into /opt/axp/bin, with
# a download cache kept across builds.
FROM debian:trixie-slim AS routine-plugins
ARG TARGETOS
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY plugins /opt/axp/plugins
COPY packages/plugins-go/out/${TARGETOS}-${TARGETARCH}/axp-plugins /usr/local/bin/
RUN --mount=type=cache,target=/var/cache/axp-plugins \
    axp-plugins setup routine /opt/axp/plugins /opt/axp/bin

FROM debian:trixie-slim
ARG TARGETOS
ARG TARGETARCH
LABEL service="axp"
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=caddy:2.11.7-alpine /usr/bin/caddy /usr/local/bin/caddy
# The controller builds agents' images with this machine's Docker (its socket).
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
# Least to most frequently changing.
COPY --from=routine-plugins /opt/axp/bin/ /usr/local/bin/
COPY apps/control-plane/out/${TARGETOS}-${TARGETARCH}/axp-control-plane /usr/local/bin/
# Self-contained static server plus SPA assets; no node_modules.
COPY apps/web/out/ /app/apps/web/
COPY apps/gateway/Caddyfile apps/gateway/*.caddy /app/apps/gateway/
# The bundles and plugins agents' images are built from; the plugins are
# also what routine runs get.
COPY bundles /app/bundles/
COPY plugins /app/plugins/
# What remote computers download from /remote/dl: the axp binaries and the
# agenvo connectors (where the control plane looks for them by default).
COPY apps/remote/out/dist/ /app/apps/remote/out/dist/
COPY apps/agenvo/out/dist/ /app/apps/agenvo/out/dist/
# The control plane finds them at ../../bundles and ../../plugins.
WORKDIR /app/apps/control-plane

CMD ["bun", "/app/apps/web/server.js"]
