"""Entry point: ``python -m axp_memory``.

It runs as the memory bundle's service (bundles/memory) and listens on
:8320. DATABASE_URL is its
PostgreSQL database (with pgvector); AXP_GATEWAY_URL the runtime gateway,
whose /v1 is the models' OpenAI-compatible API (and embeddings, when the
memories' space is the gateway's), and AXP_BUNDLE_TOKEN what it calls that
with.
"""

import os

import uvicorn

from . import telemetry
from .app import create_app
from .mem0_provider import Mem0Provider
from .rebuild import Rebuilds


def main() -> None:
    # Health checks and the web's polling are most requests and say nothing.
    telemetry.setup(
        "memory-service",
        quiet=(
            "/up",
            "/.well-known/axp-service",
            "/api/memory/v1/agents/*/memories",
            "/api/memory/v1/embedding",
        ),
    )
    provider = Mem0Provider(
        database_url=os.environ["DATABASE_URL"],
        llm_url=os.environ["AXP_GATEWAY_URL"].rstrip("/") + "/v1",
        token=os.environ["AXP_BUNDLE_TOKEN"],
    )
    # Opens the current vector space, and resumes a rebuild under way.
    rebuilds = Rebuilds(provider)
    rebuilds.start_worker()
    uvicorn.run(
        create_app(provider, rebuilds), host="0.0.0.0", port=8320, log_config=None
    )
    telemetry.shutdown()


if __name__ == "__main__":
    main()
