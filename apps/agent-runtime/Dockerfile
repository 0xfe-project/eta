# Agent runtime image: one container per agent. Dependencies come prebuilt for
# the target platform from `bun run build` (Turbo); this file only copies them.
# The workspace is mounted under /mnt: Ubuntu's fusermount3 AppArmor profile
# only allows FUSE mounts there.
FROM python:3.13-slim

ARG TARGETOS
ARG TARGETARCH
ARG JUICEFS_VERSION=1.4.1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl fuse3 git \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://github.com/juicedata/juicefs/releases/download/v${JUICEFS_VERSION}/juicefs-${JUICEFS_VERSION}-linux-${TARGETARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin juicefs
COPY out/${TARGETOS}-${TARGETARCH}/site-packages/ /usr/local/lib/python3.13/site-packages/
WORKDIR /app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY axp_runtime ./axp_runtime

ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    AXP_WORKSPACE_DIR=/mnt/workspace \
    AXP_STATE_DIR=/state
RUN mkdir -p /state
EXPOSE 8080
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["python", "-m", "axp_runtime"]
