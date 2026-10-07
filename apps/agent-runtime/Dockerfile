# Agent runtime image: one container per agent. Dependencies come prebuilt for
# the target platform from `bun run build` (Turbo); this file only copies them.
FROM python:3.13-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl fuse3 git rclone \
    && rm -rf /var/lib/apt/lists/*

ARG TARGETOS
ARG TARGETARCH
COPY out/${TARGETOS}-${TARGETARCH}/site-packages/ /usr/local/lib/python3.13/site-packages/
WORKDIR /app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY axp_runtime ./axp_runtime

ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    AXP_WORKSPACE_DIR=/workspace \
    AXP_STATE_DIR=/state
RUN mkdir -p /workspace /state
EXPOSE 8080
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["python", "-m", "axp_runtime"]
