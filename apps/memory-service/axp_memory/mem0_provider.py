"""The mem0 provider: mem0 as a library over PostgreSQL (pgvector).

Facts are extracted by the agent's own model through the LLM gateway and
embedded locally on the CPU (fastembed), so the service holds no credentials.
"""

import contextvars
import os
import tempfile
import threading
import uuid

# Read when mem0 is imported. mem0 keeps a change log in SQLite next to the
# vector store; it is not needed and stays in the container.
os.environ.setdefault("MEM0_TELEMETRY", "false")
os.environ.setdefault("MEM0_DIR", os.path.join(tempfile.gettempdir(), "mem0"))

import httpx  # noqa: E402
from mem0 import Memory as Mem0  # noqa: E402
from openai import OpenAI  # noqa: E402
from psycopg_pool import ConnectionPool  # noqa: E402

from . import embedding  # noqa: E402
from .provider import Memory  # noqa: E402

TABLE = "memories"
LIST_LIMIT = 1000

# The agent a model request is made for; the LLM gateway requires it.
_agent = contextvars.ContextVar[str]("agent")


def _name_agent(request: httpx.Request) -> None:
    request.headers["X-AXP-Agent-Id"] = _agent.get()


class Mem0Provider:
    def __init__(self, database_url: str, llm_url: str):
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
                # The client is replaced below; mem0 insists on a key.
                "llm": {"provider": "openai", "config": {"api_key": "unused"}},
            }
        )
        # The LLM gateway authenticates nothing but the agent header, which
        # the runtime gateway sets for runtimes; here it names the agent the
        # memory is extracted for.
        self.memory.llm.client = OpenAI(
            base_url=llm_url,
            api_key="unused",
            http_client=httpx.Client(
                event_hooks={"request": [_name_agent]}, timeout=120
            ),
        )
        # The model is set per extraction.
        self._extracting = threading.Lock()

    def add(self, agent_id, messages, *, infer, model=None):
        if not infer:
            return self._add(agent_id, messages, infer=False)
        with self._extracting:
            self.memory.llm.config.model = model
            token = _agent.set(agent_id)
            try:
                return self._add(agent_id, messages, infer=True)
            finally:
                _agent.reset(token)

    def _add(self, agent_id, messages, *, infer):
        result = self.memory.add(messages, user_id=agent_id, infer=infer)
        return [_memory(item) for item in result["results"]]

    def search(self, agent_id, query, limit):
        result = self.memory.search(query, top_k=limit, filters={"user_id": agent_id})
        return [_memory(item) for item in result["results"]]

    def list(self, agent_id):
        result = self.memory.get_all(filters={"user_id": agent_id}, top_k=LIST_LIMIT)
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
    return Memory(item["id"], item["memory"], item.get("score"), item.get("created_at"))
