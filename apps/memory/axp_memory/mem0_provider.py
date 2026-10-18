"""The mem0 provider: mem0 as a library over PostgreSQL (pgvector).

Facts are extracted by the model the service is configured with (an
OpenAI-compatible API) and embedded locally on the CPU (fastembed).
"""

import os
import tempfile
import uuid
from datetime import UTC, datetime

# Read when mem0 is imported. mem0 keeps a change log in SQLite next to the
# vector store; it is not needed and stays in the container.
os.environ.setdefault("MEM0_TELEMETRY", "false")
os.environ.setdefault("MEM0_DIR", os.path.join(tempfile.gettempdir(), "mem0"))

from mem0 import Memory as Mem0  # noqa: E402
from openai import OpenAI  # noqa: E402
from psycopg_pool import ConnectionPool  # noqa: E402

from . import embedding  # noqa: E402
from .provider import Memory  # noqa: E402

TABLE = "memories"
LIST_LIMIT = 1000


class Mem0Provider:
    def __init__(self, database_url: str, llm_url: str, api_key: str, model: str):
        self.memory = Mem0.from_config(
            {
                "vector_store": {
                    "provider": "pgvector",
                    "config": {
                        # Checked on checkout, so a database restart costs no
                        # failed request.
                        "connection_pool": ConnectionPool(
                            database_url,
                            min_size=1,
                            max_size=5,
                            check=ConnectionPool.check_connection,
                            open=True,
                        ),
                        "collection_name": TABLE,
                        "embedding_model_dims": embedding.DIMS,
                    },
                },
                "embedder": {
                    "provider": "fastembed",
                    "config": {
                        "model": embedding.MODEL,
                        "embedding_dims": embedding.DIMS,
                    },
                },
                # Queries are in the user's language; facts translated to
                # English would hardly match them.
                "custom_instructions": (
                    "Write every fact in the language the user wrote in."
                ),
                "llm": {
                    "provider": "openai",
                    "config": {"api_key": api_key, "model": model},
                },
            }
        )
        # mem0 reads the endpoint from the environment; this client is told
        # where the model is, and waits longer than a default request would.
        self.memory.llm.client = OpenAI(base_url=llm_url, api_key=api_key, timeout=120)

    def add(
        self,
        agent_id,
        messages,
        *,
        source,
        infer,
        group_id=None,
    ):
        # mem0 stamps created_at unless the metadata has it; stamping it here
        # lets the new memories carry it, which mem0's add result does not.
        created_at = datetime.now(UTC).isoformat()
        result = self.memory.add(
            messages,
            user_id=agent_id,
            infer=infer,
            metadata={
                "source": source,
                "created_at": created_at,
                **({"source_group_id": group_id} if group_id else {}),
            },
        )
        return [
            Memory(
                item["id"],
                item["memory"],
                created_at=created_at,
                source=source,
                source_group_id=group_id,
            )
            for item in result["results"]
        ]

    def search(self, agent_id, query, limit, *, source=None, group_id=None):
        filters = {"user_id": agent_id}
        if source is not None:
            filters["source"] = source
        if group_id is not None:
            filters["source_group_id"] = group_id
        result = self.memory.search(query, top_k=limit, filters=filters)
        return [_memory(item) for item in result["results"]]

    def list(self, agent_id, *, source=None, group_id=None):
        filters = {"user_id": agent_id}
        if source is not None:
            filters["source"] = source
        if group_id is not None:
            filters["source_group_id"] = group_id
        result = self.memory.get_all(filters=filters, top_k=LIST_LIMIT)
        return [_memory(item) for item in result["results"]]

    def delete(self, agent_id, memory_id):
        # mem0 deletes by id alone; the memory must be this agent's.
        try:
            uuid.UUID(memory_id)
        except ValueError:
            return False
        found = self.memory.get(memory_id)
        if not found or found.get("user_id") != agent_id:
            return False
        self.memory.delete(memory_id)
        return True


def _memory(item: dict) -> Memory:
    return Memory(
        item["id"],
        item["memory"],
        item.get("score"),
        item.get("created_at"),
        (item.get("metadata") or {}).get("source"),
        (item.get("metadata") or {}).get("source_group_id"),
    )
