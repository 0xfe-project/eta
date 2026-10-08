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
