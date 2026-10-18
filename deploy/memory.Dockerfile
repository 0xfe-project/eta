# The memory sidecar (apps/memory): mem0 over PostgreSQL with pgvector.
#
#   docker build -f deploy/memory.Dockerfile -t eta-memory .
#
# Build context: the repository root. The embedding model is downloaded at build time, so the
# service never reaches the network for it. Configuration is environment (see apps/memory/axp_memory/__main__.py).
FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_COMPILE_BYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FASTEMBED_CACHE_PATH=/app/models
COPY apps/memory/pyproject.toml apps/memory/uv.lock ./
RUN uv sync --frozen --no-dev
COPY apps/memory/axp_memory axp_memory
RUN /app/.venv/bin/python -m axp_memory.embedding \
  && chmod -R a+rX /app
ENV HF_HUB_OFFLINE=1
USER nobody
EXPOSE 8320
CMD ["/app/.venv/bin/python", "-m", "axp_memory"]
