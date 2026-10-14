"""Entry point: ``python -m axp_memory``.

It runs as the memory bundle's service (bundles/memory):
AXP_MEMORY_ADDR is the listen address (host:port); DATABASE_URL its
PostgreSQL database (with pgvector); AXP_GATEWAY_URL the runtime gateway,
whose /v1 is the models' OpenAI-compatible API, and AXP_BUNDLE_TOKEN what it
calls that with.
"""

import os

import axp_telemetry
import uvicorn

from .app import create_app
from .mem0_provider import Mem0Provider


def main() -> None:
    # Health checks and the web's polling are most requests and say nothing.
    axp_telemetry.setup(
        "memory-service",
        quiet=("/up", "/.well-known/axp-service", "/api/memory/v1/agents/*/memories"),
    )
    host, _, port = os.environ.get("AXP_MEMORY_ADDR", "0.0.0.0:8320").rpartition(":")
    provider = Mem0Provider(
        database_url=os.environ["DATABASE_URL"],
        llm_url=os.environ["AXP_GATEWAY_URL"].rstrip("/") + "/v1",
        token=os.environ["AXP_BUNDLE_TOKEN"],
    )
    uvicorn.run(
        create_app(provider), host=host or "0.0.0.0", port=int(port), log_config=None
    )
    axp_telemetry.shutdown()


if __name__ == "__main__":
    main()
