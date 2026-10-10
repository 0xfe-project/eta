# The agent runtime's base image. The control plane builds each agent's image
# on it: its bundles' scripts, then their plugins, compiled for Codex
# (docs/architecture/bundles.md). The runtime (out/main.js, built by Turbo)
# drives Codex's app-server over its stdio; the agent's state lives on its
# volume at /agent.

# akhook, the rule engine of the agent's hooks, from the vendor/akhook
# submodule (the `akhook-src` build context, see scripts/build/image.sh). Built
# for the target platform; the same Debian release as the runtime below.
FROM rust:1.97-slim-trixie AS akhook
WORKDIR /src
COPY --from=akhook-src Cargo.toml Cargo.lock ./
COPY --from=akhook-src src ./src
COPY --from=akhook-src presets ./presets
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked && cp target/release/akhook /akhook

FROM node:24-trixie-slim

ARG TARGETOS
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*
# Codex, at the version the runtime's protocol types are generated from
# (package.json's @openai/codex; scripts/build/image.sh passes it).
ARG CODEX_VERSION
RUN test -n "$CODEX_VERSION" \
    && npm install --global --no-fund --no-audit "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force && codex --version
# gh, logged in as the GitHub App by the runtime (GH_CONFIG_DIR, outside the
# agent's volume). A release binary, checked against the release's checksums.
ARG GH_VERSION=2.102.0
RUN set -eu; \
    archive="gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    base="https://github.com/cli/cli/releases/download/v${GH_VERSION}"; \
    cd /tmp; \
    curl -fsSLO "${base}/${archive}"; \
    curl -fsSL "${base}/gh_${GH_VERSION}_checksums.txt" | grep " ${archive}\$" | sha256sum -c -; \
    tar -xzf "${archive}" --strip-components=2 -C /usr/local/bin "gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh"; \
    rm "${archive}"; \
    gh --version
ENV GH_CONFIG_DIR=/run/axp/gh
# git gets GitHub credentials from gh.
COPY git/gitconfig /etc/gitconfig
# akhook runs the agent's hooks (managed hooks in /etc/codex/requirements.toml):
# the plugins' lifecycle rules (compiled into each agent's image) and the
# image's rules, which it checks every shell command and file change against
# before Codex runs it; the image's come last, so no plugin overrides them.
COPY --from=akhook /akhook /usr/local/bin/akhook
COPY hooks /etc/akhook
ENV AKHOOK_ADDITIONAL_CONFIG_PATH=/opt/axp/plugins/akhook.yml:/etc/akhook/akhook.yml \
    AKHOOK_STATE_DIR=/run/akhook
# The static Codex configuration. axp-plugins (packages/plugins-go, the
# `plugins-tool` build context) compiles an agent's plugins when its image is
# built.
COPY codex /etc/codex
COPY --from=plugins-tool ${TARGETOS}-${TARGETARCH}/axp-plugins /usr/local/bin/axp-plugins
COPY out/main.js /app/main.js

ENV AXP_HOME=/agent \
    CODEX_HOME=/agent/codex
CMD ["node", "/app/main.js"]
