"""The mem0 provider: mem0 as a library over PostgreSQL (pgvector).

Facts are extracted by the agent's own model through the LLM gateway. They
are embedded in the current vector space (rebuild.Space): locally on the CPU
(fastembed), or by the gateway's /v1/embeddings, so the service holds no
credentials either way. Changing the space rebuilds every vector in the
background (rebuild.Rebuilds), then swaps the mem0 instance.
"""

import contextlib
import contextvars
import os
import tempfile
import threading
import uuid
from collections.abc import Callable
from datetime import UTC, datetime

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
from .rebuild import Space  # noqa: E402

LIST_LIMIT = 1000

# The agent a model request is made for; the LLM gateway requires it.
_agent = contextvars.ContextVar[str]("agent")


def _name_agent(request: httpx.Request) -> None:
    # Without one, the gateway books the request to the memory bundle.
    if agent := _agent.get(""):
        request.headers["X-AXP-Agent-Id"] = agent


@contextlib.contextmanager
def as_agent(agent_id: str):
    """Model and embedding requests in the block are made for the agent."""
    token = _agent.set(agent_id)
    try:
        yield
    finally:
        _agent.reset(token)


class WriteGate:
    """Writes pass while it is open; closing it waits for those in flight
    and holds new ones until it opens again. A rebuild closes it to catch up
    and switch spaces with no write in between."""

    def __init__(self):
        self._cond = threading.Condition()
        self._writers = 0
        self._closed = False

    @contextlib.contextmanager
    def write(self):
        with self._cond:
            while self._closed:
                self._cond.wait()
            self._writers += 1
        try:
            yield
        finally:
            with self._cond:
                self._writers -= 1
                self._cond.notify_all()

    @contextlib.contextmanager
    def closed(self):
        with self._cond:
            while self._closed:
                self._cond.wait()
            self._closed = True
            while self._writers:
                self._cond.wait()
        try:
            yield
        finally:
            with self._cond:
                self._closed = False
                self._cond.notify_all()


class _Lent:
    """The provider's pool, lent to one mem0 instance. mem0 closes its pool
    when the instance goes away, as the one a switch replaces does; the
    pool is the provider's, and every instance's."""

    def __init__(self, pool: ConnectionPool):
        self._pool = pool

    def connection(self, *args, **kwargs):
        return self._pool.connection(*args, **kwargs)

    def close(self, *args, **kwargs) -> None:
        pass


class Mem0Provider:
    def __init__(
        self,
        database_url: str,
        llm_url: str,
        token: str,
        *,
        make_embedder: Callable[[Space], object] | None = None,
    ):
        # Checked on checkout, so a database restart costs no failed request.
        self.pool = ConnectionPool(
            database_url,
            min_size=1,
            max_size=5,
            check=ConnectionPool.check_connection,
            open=True,
        )
        self.llm_url = llm_url
        self.token = token
        # Tests embed without a model.
        self._make_embedder = make_embedder
        self._init_state()

    def _init_state(self):
        # The model is set per extraction.
        self._extracting = threading.Lock()
        self.gate = WriteGate()
        # Set by a rebuild while it runs: (memory ids, "add" | "delete").
        self.on_change: Callable[[list[str], str], None] | None = None

    def open(self, space: Space) -> None:
        """Serve the space; rebuild.Rebuilds calls it on start."""
        self.memory = self.build(space)
        self.space = space

    def build(self, space: Space):
        """A mem0 instance over the space's table, embedding as it says."""
        if self._make_embedder is not None or space.embedder != "local":
            # The client is replaced below; mem0 insists on a key.
            embedder = {
                "provider": "openai",
                "config": {
                    "model": space.gateway_model or "unused",
                    "embedding_dims": space.dims,
                    "api_key": "unused",
                },
            }
        else:
            embedder = {
                "provider": "fastembed",
                "config": {"model": embedding.MODEL, "embedding_dims": space.dims},
            }
        memory = Mem0.from_config(
            {
                "vector_store": {
                    "provider": "pgvector",
                    "config": {
                        "connection_pool": _Lent(self.pool),
                        "collection_name": space.table,
                        "embedding_model_dims": space.dims,
                    },
                },
                "embedder": embedder,
                # Queries are in the user's language; facts translated to
                # English would hardly match them.
                "custom_instructions": (
                    "Write every fact in the language the user wrote in."
                ),
                "llm": {"provider": "openai", "config": {"api_key": "unused"}},
            }
        )
        # Through the runtime gateway with the bundle's token, which may call
        # models; the agent header says whose usage the request is.
        memory.llm.client = self._client()
        if self._make_embedder is not None:
            memory.embedding_model = self._make_embedder(space)
        elif space.embedder != "local":
            memory.embedding_model.client = self._client(timeout=60)
        return memory

    def _client(self, timeout: float = 120) -> OpenAI:
        return OpenAI(
            base_url=self.llm_url,
            api_key=self.token,
            http_client=httpx.Client(
                event_hooks={"request": [_name_agent]}, timeout=timeout
            ),
        )

    def swap(self, memory, space: Space) -> None:
        """Serve memory (built for space) from now on; the gate is closed."""
        self.memory, self.space = memory, space

    def add(
        self,
        agent_id,
        messages,
        *,
        source,
        infer,
        model=None,
        group_id=None,
    ):
        with self.gate.write(), as_agent(agent_id):
            if not infer:
                return self._add(
                    self.memory,
                    agent_id,
                    messages,
                    source,
                    infer=False,
                    group_id=group_id,
                )
            with self._extracting:
                memory = self.memory
                memory.llm.config.model = model
                return self._add(
                    memory, agent_id, messages, source, infer=True, group_id=group_id
                )

    def _add(self, memory, agent_id, messages, source, *, infer, group_id):
        # mem0 stamps created_at unless the metadata has it; stamping it here
        # lets the new memories carry it, which mem0's add result does not.
        created_at = datetime.now(UTC).isoformat()
        result = memory.add(
            messages,
            user_id=agent_id,
            infer=infer,
            metadata={
                "source": source,
                "created_at": created_at,
                **({"source_group_id": group_id} if group_id else {}),
            },
        )
        if (record := self.on_change) and result["results"]:
            record([item["id"] for item in result["results"]], "add")
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
        with as_agent(agent_id):
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
        with self.gate.write(), as_agent(agent_id):
            memory = self.memory
            found = memory.get(memory_id)
            if not found or found.get("user_id") != agent_id:
                return False
            memory.delete(memory_id)
            if record := self.on_change:
                record([memory_id], "delete")
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
