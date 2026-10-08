# Agent runtime image: one container per agent. Dependencies come prebuilt for
# the target platform from `bun run build` (Turbo); this file only copies them.
# The agent's home (/agent: workspace and Codex state) lives in the container
# and is restored from, and saved to, its snapshot.

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

FROM python:3.13-slim

ARG TARGETOS
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git zstd \
    && rm -rf /var/lib/apt/lists/*
COPY out/${TARGETOS}-${TARGETARCH}/site-packages/ /usr/local/lib/python3.13/site-packages/
# gh, for agents to read GitHub; the hooks below keep it to reads. A release
# binary, checked against the release's checksums. /usr/local/bin/gh is
# bin/axp-forge, which runs it with a token from the forge service.
ARG GH_VERSION=2.102.0
RUN set -eu; \
    archive="gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    base="https://github.com/cli/cli/releases/download/v${GH_VERSION}"; \
    cd /tmp; \
    curl -fsSLO "${base}/${archive}"; \
    curl -fsSL "${base}/gh_${GH_VERSION}_checksums.txt" | grep " ${archive}\$" | sha256sum -c -; \
    mkdir -p /usr/local/lib/gh; \
    tar -xzf "${archive}" --strip-components=2 -C /usr/local/lib/gh "gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh"; \
    rm "${archive}"; \
    /usr/local/lib/gh/gh --version
# git and gh get GitHub credentials from the forge service (bin/axp-forge).
COPY git/gitconfig /etc/gitconfig
COPY bin /opt/axp/bin
RUN ln -s /opt/axp/bin/axp-forge /usr/local/bin/gh
# The hooks' rules: akhook checks every shell command and file change against
# them before Codex runs it (a managed hook in /etc/codex/requirements.toml).
# Approval requests live outside /agent, so no snapshot keeps them.
COPY --from=akhook /akhook /usr/local/bin/akhook
COPY hooks /etc/akhook
ENV AKHOOK_ADDITIONAL_CONFIG_PATH=/etc/akhook/akhook.yml \
    AKHOOK_STATE_DIR=/run/akhook
# The static Codex configuration (sandbox, approvals), then the plugins every
# agent can run with: their setup scripts prepare their environments (with a
# download cache kept across builds), and the plugins become a local
# marketplace whose tool approvals and hooks join the Codex configuration.
COPY codex /etc/codex
COPY plugins /opt/axp/plugins
RUN --mount=type=bind,source=axp_runtime/plugins.py,target=/tmp/plugins.py \
    --mount=type=cache,target=/var/cache/axp-plugins \
    python /tmp/plugins.py /opt/axp/plugins /etc/codex
WORKDIR /app
COPY axp_runtime ./axp_runtime

ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    AXP_HOME=/agent
CMD ["python", "-m", "axp_runtime"]
