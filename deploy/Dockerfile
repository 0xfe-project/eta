# Production image for every Kamal role (gateway, web, api, internal,
# controller, llm); the roles differ only in their command. Build context is
# the repository root. Agent runtimes use apps/agent-runtime.
FROM golang:1.26 AS go
WORKDIR /src
COPY go.work ./
COPY apps/gateway/go.mod apps/gateway/
COPY apps/llm-gateway/go.mod apps/llm-gateway/go.sum* apps/llm-gateway/
RUN go -C apps/gateway mod download && go -C apps/llm-gateway mod download
COPY apps/gateway apps/gateway
COPY apps/llm-gateway apps/llm-gateway
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/axp-gateway ./apps/gateway \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/axp-llm-gateway ./apps/llm-gateway

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
COPY --from=go /out/ /usr/local/bin/
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
EXPOSE 3000 8000 8001 8080 8317
CMD ["bun", "/app/apps/web/server.js"]
