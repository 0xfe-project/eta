# Agent runtime image: one container per agent.
FROM python:3.13-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl fuse3 git rclone \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN UV_PROJECT_ENVIRONMENT=/opt/venv uv sync --frozen --no-dev --no-install-project
COPY axp_runtime ./axp_runtime
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    AXP_WORKSPACE_DIR=/workspace \
    AXP_STATE_DIR=/state
RUN mkdir -p /workspace /state
EXPOSE 8080
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["python", "-m", "axp_runtime"]
