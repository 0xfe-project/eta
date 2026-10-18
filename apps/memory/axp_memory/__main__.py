"""Entry point: ``python -m axp_memory``.

The memory sidecar of the eta host. Environment:

  DATABASE_URL         its PostgreSQL database (with pgvector)
  MEMORY_LLM_BASE_URL  an OpenAI-compatible API (the chat completions
                       endpoint's base, e.g. https://api.openai.com/v1) ...
  MEMORY_LLM_API_KEY   ... the key it is called with ...
  MEMORY_LLM_MODEL     ... and the model that extracts facts from turns
  MEMORY_HOST          the interface to listen on (default 127.0.0.1)
  MEMORY_PORT          the port (default 8320)
"""

import os

import uvicorn

from . import telemetry
from .app import create_app
from .mem0_provider import Mem0Provider


def main() -> None:
    # Health checks and the web's polling are most requests and say nothing.
    telemetry.setup(
        "memory-service",
        quiet=("/up", "/.well-known/axp-service", "/api/memory/v1/agents/*/memories"),
    )
    provider = Mem0Provider(
        database_url=os.environ["DATABASE_URL"],
        llm_url=os.environ["MEMORY_LLM_BASE_URL"].rstrip("/"),
        api_key=os.environ["MEMORY_LLM_API_KEY"],
        model=os.environ["MEMORY_LLM_MODEL"],
    )
    uvicorn.run(
        create_app(provider),
        host=os.environ.get("MEMORY_HOST", "127.0.0.1"),
        port=int(os.environ.get("MEMORY_PORT", "8320")),
        log_config=None,
    )
    telemetry.shutdown()


if __name__ == "__main__":
    main()
