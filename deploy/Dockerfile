# Production image for every Kamal role (gateway, web, api, internal,
# controller, llm); the roles differ only in their command. Build context is
# the repository root. Agent runtimes use apps/agent-runtime.
#
# Nothing is compiled or installed here: `bun run build` (Turbo) produces the
# artifacts for each target platform outside Docker, and this file only copies
# them. Each COPY layer is reused while its files are byte-identical.
FROM python:3.13-slim
ARG TARGETOS
ARG TARGETARCH
LABEL service="axp"
COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun
# Least to most frequently changing.
COPY apps/control-plane/out/${TARGETOS}-${TARGETARCH}/site-packages/ /usr/local/lib/python3.13/site-packages/
COPY apps/llm-gateway/out/${TARGETOS}-${TARGETARCH}/axp-llm-gateway /usr/local/bin/
COPY apps/gateway/out/${TARGETOS}-${TARGETARCH}/axp-gateway /usr/local/bin/
# Self-contained server bundle plus client assets; no node_modules.
COPY apps/web/out/ /app/apps/web/
WORKDIR /app/apps/control-plane
COPY apps/control-plane/manage.py ./
COPY apps/control-plane/config config/
COPY apps/control-plane/chat chat/

ENV PYTHONUNBUFFERED=1 \
    DJANGO_DEBUG=false
EXPOSE 3000 8000 8001 8080 8317
CMD ["bun", "/app/apps/web/server.js"]
