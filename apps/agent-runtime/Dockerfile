# Agent runtime image: one container per agent. Dependencies come prebuilt for
# the target platform from `bun run build` (Turbo); this file only copies them.
# The agent's home (/agent: workspace and Codex state) lives in the container
# and is restored from, and saved to, its snapshot.
FROM python:3.13-slim

ARG TARGETOS
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git zstd \
    && rm -rf /var/lib/apt/lists/*
COPY out/${TARGETOS}-${TARGETARCH}/site-packages/ /usr/local/lib/python3.13/site-packages/
# grok-api, the grok plugin's MCP server: a release binary, checked against the
# release's checksums.
ARG GROK_API_VERSION=0.1.1
RUN set -eu; \
    case "${TARGETARCH}" in amd64) arch=x86_64 ;; arm64) arch=aarch64 ;; esac; \
    archive="grok-api-${arch}-unknown-linux-gnu.tar.gz"; \
    base="https://github.com/AkaraChen/grok-api/releases/download/v${GROK_API_VERSION}"; \
    cd /tmp; \
    curl -fsSLO "${base}/${archive}"; \
    curl -fsSL "${base}/SHA256SUMS" | grep " ${archive}\$" | sha256sum -c -; \
    tar -xzf "${archive}" -C /usr/local/bin grok-api; \
    rm "${archive}"; \
    grok-api --version
# The Codex plugins every agent gets (a local marketplace, installed at start)
# and the static Codex configuration: sandbox, approvals, hooks.
COPY plugins /opt/axp/plugins
COPY codex /etc/codex
WORKDIR /app
COPY axp_runtime ./axp_runtime

ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    AXP_HOME=/agent
EXPOSE 8080
CMD ["python", "-m", "axp_runtime"]
