# The memory bundle's service (memory.yaml next to this file),
# from the artifacts Turbo builds (`build`, `build:linux-<arch>`): the
# dependencies, the embedding model, the source. scripts/build/image.sh
# builds it as axp-memory.
FROM python:3.13-slim
ARG TARGETOS
ARG TARGETARCH
COPY out/${TARGETOS}-${TARGETARCH}/site-packages/ /usr/local/lib/python3.13/site-packages/
COPY out/models/ /app/models/
COPY axp_memory /app/axp_memory/
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    FASTEMBED_CACHE_PATH=/app/models \
    HF_HUB_OFFLINE=1 \
    AXP_MEMORY_ADDR=0.0.0.0:8320
EXPOSE 8320
USER nobody
CMD ["python", "-m", "axp_memory"]
