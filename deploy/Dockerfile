# Production image for every Kamal role (web, api, internal, controller); the
# roles differ only in their command. Build context is the repository root.
# Agent runtimes use apps/agent-runtime.
FROM oven/bun:1.3.14 AS web
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile
COPY apps/web apps/web
RUN bun run --cwd apps/web build

FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /usr/local/bin/uv
COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY apps/control-plane/pyproject.toml apps/control-plane/uv.lock apps/control-plane/.python-version apps/control-plane/
RUN cd apps/control-plane \
    && UV_PROJECT_ENVIRONMENT=/opt/venv UV_PYTHON_DOWNLOADS=never uv sync --frozen --no-dev
COPY apps/control-plane apps/control-plane
COPY --from=web /app/node_modules node_modules
COPY --from=web /app/apps/web apps/web

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    DJANGO_DEBUG=false
WORKDIR /app/apps/control-plane
EXPOSE 3000 8000 8001
CMD ["bun", "/app/apps/web/server.js"]
