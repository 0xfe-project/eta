"""Entry point: ``python -m axp_memory``.

AXP_MEMORY_ADDR is the listen address (host:port); DATABASE_URL the
PostgreSQL database with pgvector; AXP_LLM_GATEWAY_URL the LLM gateway, whose
OpenAI-compatible API is under /v1.
"""

import os

import axp_telemetry
import uvicorn

from .app import create_app
from .mem0_provider import Mem0Provider

DEFAULT_DATABASE_URL = "postgres://axp:axp@127.0.0.1:15432/axp"


def main() -> None:
    # Health checks and the web's polling are most requests and say nothing.
    axp_telemetry.setup(
        "memory-service", quiet=("/up", "/api/memory/v1/agents/*/memories")
    )
    host, _, port = os.environ.get("AXP_MEMORY_ADDR", "0.0.0.0:8320").rpartition(":")
    provider = Mem0Provider(
        database_url=os.environ.get("DATABASE_URL", DEFAULT_DATABASE_URL),
        llm_url=os.environ.get("AXP_LLM_GATEWAY_URL", "http://axp-api:8001").rstrip("/")
        + "/v1",
    )
    uvicorn.run(
        create_app(provider), host=host or "0.0.0.0", port=int(port), log_config=None
    )
    axp_telemetry.shutdown()


if __name__ == "__main__":
    main()
