# Production image for every Kamal role (gateway, runtime-gateway, web, api,
# internal, controller, llm, memory); the roles differ only in their command. Build
# context is the repository root. Agent runtimes use apps/agent-runtime.
#
# Nothing is compiled or installed here: `bun run build` (Turbo) produces the
# artifacts for each target platform outside Docker, and this file only copies
# them. Each COPY layer is reused while its files are byte-identical.
FROM python:3.13-slim
ARG TARGETOS
ARG TARGETARCH
LABEL service="axp"
COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=caddy:2.11.7-alpine /usr/bin/caddy /usr/local/bin/caddy
# Least to most frequently changing.
COPY apps/control-plane/out/${TARGETOS}-${TARGETARCH}/site-packages/ /usr/local/lib/python3.13/site-packages/
# The memory service's dependencies stay apart from the control plane's; its
# role puts them first on PYTHONPATH. Then its embedding model.
COPY apps/memory-service/out/${TARGETOS}-${TARGETARCH}/site-packages/ /app/apps/memory-service/site-packages/
COPY apps/memory-service/out/models/ /app/apps/memory-service/models/
COPY apps/llm-gateway/out/${TARGETOS}-${TARGETARCH}/axp-llm-gateway /usr/local/bin/
# Self-contained server bundle plus client assets; no node_modules.
COPY apps/web/out/ /app/apps/web/
COPY apps/gateway/Caddyfile apps/gateway/*.caddy /app/apps/gateway/
COPY apps/memory-service/axp_memory /app/apps/memory-service/axp_memory/
# The runtime image's plugins: the catalog agents choose from.
COPY apps/agent-runtime/plugins /app/apps/agent-runtime/plugins/
WORKDIR /app/apps/control-plane
COPY apps/control-plane/manage.py apps/control-plane/gunicorn.conf.py ./
COPY apps/control-plane/config config/
COPY apps/control-plane/chat chat/

ENV PYTHONUNBUFFERED=1
EXPOSE 3000 8000 8001 8080 8090 8317 8320
CMD ["bun", "/app/apps/web/server.js"]
