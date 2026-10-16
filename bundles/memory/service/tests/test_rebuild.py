"""Rebuilding the vectors into another space, on PostgreSQL with pgvector
(scripts/test-postgres.sh) and a fake embedder."""

import hashlib
import math
import os
import threading
import time
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import openai
import psycopg
import pytest
from psycopg import sql
from starlette.testclient import TestClient

from axp_memory import mem0_provider
from axp_memory.app import create_app
from axp_memory.mem0_provider import Mem0Provider
from axp_memory.rebuild import DEFAULT, NO_ACCOUNT, Conflict, Rebuilds, Space

BASE_URL = os.environ.get("DATABASE_URL", "postgres://axp:axp@127.0.0.1:15432/axp")
GEMINI = Space("gateway:gemini-embedding-001", 768)
OTHER = Space("gateway:gemini-embedding-2-preview", 256)


def _with_db(url: str, name: str) -> str:
    return url.rsplit("/", 1)[0] + "/" + name


@pytest.fixture
def database_url():
    name = f"axp_memory_test_{os.getpid()}_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(_with_db(BASE_URL, "postgres"), autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    url = _with_db(BASE_URL, name)
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
    yield url
    with psycopg.connect(_with_db(BASE_URL, "postgres"), autocommit=True) as admin:
        admin.execute(
            sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name))
        )


class Embedders:
    """Fake embedders: a text's vector is a hash of it, so a query finds its
    own text; failures and calls are by embedder."""

    def __init__(self):
        self.fail: dict[str, Exception] = {}
        self.wrong_dims: set[str] = set()
        self.calls: list[tuple[str, str, list[str]]] = []

    def make(self, space: Space):
        embedders = self

        class Fake:
            def embed(self, text, memory_action=None):
                return self.embed_batch([text], memory_action)[0]

            def embed_batch(self, texts, memory_action="add"):
                if error := embedders.fail.get(space.embedder):
                    raise error
                agent = mem0_provider._agent.get("")
                embedders.calls.append((space.embedder, agent, list(texts)))
                dims = space.dims + (1 if space.embedder in embedders.wrong_dims else 0)
                return [_vector(text, dims) for text in texts]

        return Fake()

    def texts(self, embedder: str) -> list[str]:
        return [t for e, _, texts in self.calls if e == embedder for t in texts]


def _vector(text: str, dims: int) -> list[float]:
    seed = hashlib.sha256(text.encode()).digest()
    v = [((seed[i % 32] + i * 7) % 255) - 127.0 for i in range(dims)]
    norm = math.sqrt(sum(x * x for x in v))
    return [x / norm for x in v]


@pytest.fixture
def embedders():
    return Embedders()


@pytest.fixture
def open_service(database_url, embedders):
    """Starts the service's provider and rebuilds on the database, as a
    process start does; every one is closed at the end."""
    opened = []

    def open_(**kwargs):
        provider = Mem0Provider(
            database_url,
            "http://gateway.invalid/v1",
            "token",
            make_embedder=embedders.make,
        )
        rebuilds = Rebuilds(provider, **kwargs)
        opened.append(provider)
        return provider, rebuilds

    yield open_
    for provider in opened:
        provider.pool.close()


def remember(provider, agent, text):
    [memory] = provider.add(
        agent, [{"role": "user", "content": text}], source="user", infer=False
    )
    return memory.id


def rows(provider, table):
    with provider.pool.connection() as conn:
        if conn.execute("SELECT to_regclass(%s)", (table,)).fetchone()[0] is None:
            return None
        return {
            str(i): payload["data"]
            for i, payload in conn.execute(
                sql.SQL("SELECT id, payload FROM {}").format(sql.Identifier(table))
            )
        }


def test_the_first_start_takes_the_memories_as_the_local_space(open_service):
    provider, rebuilds = open_service()
    assert provider.space == DEFAULT
    assert provider.space.table == "memories"
    remember(provider, "a", "喜欢简洁的回答")
    status = rebuilds.status()
    assert status == {
        "space": {"model": "local", "dims": 768},
        "memories": 1,
        "rebuild": None,
    }
    # Restarting keeps the space.
    provider, _ = open_service()
    assert provider.space == DEFAULT
    assert [m.text for m in provider.list("a")] == ["喜欢简洁的回答"]


def test_a_rebuild_copies_every_memory_then_switches(open_service, embedders):
    provider, rebuilds = open_service(batch=2)
    ids = {
        remember(provider, agent, f"{agent} 的第 {i} 条记忆")
        for agent in ("a", "b")
        for i in range(3)
    }
    before = rows(provider, "memories")
    with pytest.raises(Conflict):
        rebuilds.start(DEFAULT)

    rebuilds.start(GEMINI)
    status = rebuilds.run_to_end()

    assert status["rebuild"]["status"] == "done"
    assert status["rebuild"]["done"] == status["rebuild"]["total"] == 6
    assert status["space"] == GEMINI.view()
    assert provider.space == GEMINI
    assert rows(provider, GEMINI.table) == before
    assert set(before) == ids
    # Each agent's memories were embedded as that agent's.
    for embedder, agent, texts in embedders.calls:
        if embedder == GEMINI.embedder and agent:
            assert all(t.startswith(agent) for t in texts)
    assert sorted(embedders.texts(GEMINI.embedder)) == sorted(
        ["记忆 embedding 探测 / memory embedding probe", *before.values()]
    )
    # Search uses the new space at once.
    found = provider.search("b", "b 的第 1 条记忆", 1)
    assert [m.text for m in found] == ["b 的第 1 条记忆"]
    assert embedders.calls[-1][:2] == (GEMINI.embedder, "b")
    # A restart serves the new space; the old table stays until the next
    # rebuild, as the way back.
    restarted, again = open_service()
    assert restarted.space == GEMINI
    assert rows(restarted, "memories") == before
    again.start(OTHER)
    again.run_to_end()
    assert rows(restarted, "memories") is None
    assert rows(restarted, OTHER.table) == before


def test_a_restart_resumes_from_the_cursor(open_service, embedders):
    provider, rebuilds = open_service(batch=2)
    for i in range(5):
        remember(provider, "a", f"记忆 {i}")
    rebuilds.start(GEMINI)
    rebuilds.step()  # prepare
    rebuilds.step()  # the first two
    assert rebuilds.status()["rebuild"]["done"] == 2
    copied = set(embedders.texts(GEMINI.embedder))
    provider.pool.close()

    provider, rebuilds = open_service(batch=2)
    assert provider.space == DEFAULT
    embedders.calls.clear()
    status = rebuilds.run_to_end()

    assert status["rebuild"]["status"] == "done"
    assert status["rebuild"]["done"] == 5
    assert len(rows(provider, GEMINI.table)) == 5
    # Nothing was embedded twice.
    again = set(embedders.texts(GEMINI.embedder))
    assert not (again & copied - {"记忆 embedding 探测 / memory embedding probe"})


def test_what_changes_meanwhile_is_caught_up(open_service):
    provider, rebuilds = open_service(batch=2)
    first = [remember(provider, "a", f"旧记忆 {i}") for i in range(4)]
    rebuilds.start(GEMINI)
    rebuilds.step()  # prepare
    rebuilds.step()  # two copied
    # Saved and forgotten while the rest is copied (by id: some of these
    # were copied, some not).
    assert provider.delete("a", first[0])
    added = remember(provider, "a", "新记忆")
    assert provider.delete("a", first[3])
    status = rebuilds.run_to_end()

    assert status["rebuild"]["status"] == "done"
    want = rows(provider, "memories")
    assert set(want) == {first[1], first[2], added}
    assert rows(provider, GEMINI.table) == want
    with provider.pool.connection() as conn:
        assert conn.execute(
            "SELECT count(*) FROM embedding_rebuild_changes"
        ).fetchone() == (0,)
    # Writes no longer record changes.
    assert provider.on_change is None


def test_writes_wait_for_the_switch(open_service):
    provider, rebuilds = open_service()
    remember(provider, "a", "旧记忆")
    rebuilds.start(GEMINI)
    with provider.gate.closed():
        done = threading.Event()
        threading.Thread(
            target=lambda: (remember(provider, "a", "等待中"), done.set()),
            daemon=True,
        ).start()
        time.sleep(0.2)
        assert not done.is_set()
    assert done.wait(5)


def test_a_failed_probe_creates_nothing(open_service, embedders):
    provider, rebuilds = open_service()
    remember(provider, "a", "记忆")
    embedders.fail[GEMINI.embedder] = RuntimeError("connection refused")
    rebuilds.start(GEMINI)
    status = rebuilds.run_to_end()
    assert status["rebuild"]["status"] == "failed"
    assert "connection refused" in status["rebuild"]["error"]
    assert rows(provider, GEMINI.table) is None
    assert provider.space == DEFAULT
    assert provider.on_change is None

    # Vectors of another length fail too.
    embedders.wrong_dims.add(OTHER.embedder)
    rebuilds.start(OTHER)
    status = rebuilds.run_to_end()
    assert status["rebuild"]["status"] == "failed"
    assert "257" in status["rebuild"]["error"]
    assert rows(provider, OTHER.table) is None


def test_cancelling_drops_the_half_built_table(open_service):
    provider, rebuilds = open_service(batch=1)
    for i in range(3):
        remember(provider, "a", f"记忆 {i}")
    rebuilds.start(GEMINI)
    rebuilds.step()
    rebuilds.step()
    assert len(rows(provider, GEMINI.table)) == 1
    assert rebuilds.cancel()
    assert not rebuilds.cancel()
    assert rows(provider, GEMINI.table) is None
    assert rebuilds.status()["rebuild"]["status"] == "cancelled"
    assert provider.space == DEFAULT
    assert provider.on_change is None
    assert not rebuilds.step()


def test_the_last_of_two_switches_wins(open_service):
    provider, rebuilds = open_service(batch=1)
    for i in range(3):
        remember(provider, "a", f"记忆 {i}")
    rebuilds.start(GEMINI)
    rebuilds.step()
    rebuilds.step()
    rebuilds.start(OTHER)
    assert rows(provider, GEMINI.table) is None
    status = rebuilds.run_to_end()
    assert status["rebuild"]["status"] == "done"
    assert status["space"] == OTHER.view()
    assert rows(provider, GEMINI.table) is None
    assert len(rows(provider, OTHER.table)) == 3


def _gateway_error(status: int, code: str) -> openai.APIStatusError:
    request = httpx.Request("POST", "http://gateway.invalid/v1/embeddings")
    body = {"message": code, "type": "server_error", "code": code}
    response = httpx.Response(status, request=request, json={"error": body})
    return openai.APIStatusError(code, response=response, body=body)


def _due(provider):
    with provider.pool.connection() as conn:
        conn.execute(
            "UPDATE embedding_rebuild SET retry_at = %s",
            (datetime.now(UTC) - timedelta(seconds=1),),
        )


def test_no_account_pauses_until_there_is_one(open_service, embedders):
    provider, rebuilds = open_service()
    remember(provider, "a", "记忆")
    rebuilds.start(GEMINI)
    rebuilds.step()  # probed
    embedders.fail[GEMINI.embedder] = _gateway_error(503, "no_account")
    status = rebuilds.run_to_end()
    assert status["rebuild"]["status"] == "paused"
    assert status["rebuild"]["error"] == NO_ACCOUNT
    # It waits a minute, then tries again by itself.
    assert not rebuilds.step()
    del embedders.fail[GEMINI.embedder]
    _due(provider)
    status = rebuilds.run_to_end()
    assert status["rebuild"]["status"] == "done"
    assert status["rebuild"]["error"] is None


def test_transient_failures_back_off_then_pause(open_service, embedders):
    provider, rebuilds = open_service(failures_to_pause=3)
    remember(provider, "a", "记忆")
    rebuilds.start(GEMINI)
    rebuilds.step()
    embedders.fail[GEMINI.embedder] = _gateway_error(429, "rate_limited")
    for _ in range(2):
        rebuilds.step()
        assert rebuilds.status()["rebuild"]["status"] == "running"
        assert not rebuilds.step()  # backing off
        _due(provider)
    rebuilds.step()
    assert rebuilds.status()["rebuild"]["status"] == "paused"


def test_the_api(open_service):
    provider, rebuilds = open_service()
    remember(provider, "a", "记忆")
    with TestClient(create_app(provider, rebuilds)) as client:
        url = "/api/memory/v1/embedding"
        assert client.get(url).json()["space"] == {"model": "local", "dims": 768}
        assert client.put(url, json={"model": "local", "dims": 768}).status_code == 409
        for bad in (
            {"model": "openai", "dims": 768},
            {"model": "local", "dims": 512},
            {"model": "gateway:x", "dims": 64},
            {"model": "gateway:x", "dims": "768"},
        ):
            response = client.put(url, json=bad)
            assert response.status_code == 400, bad
            assert response.json()["error"]["code"] == "INVALID_SPACE"
        response = client.put(url, json={"model": GEMINI.embedder, "dims": 768})
        assert response.status_code == 202
        assert response.json()["rebuild"]["status"] == "running"
        assert response.json()["rebuild"]["model"] == GEMINI.embedder
        assert client.delete(f"{url}/rebuild").status_code == 204
        assert client.delete(f"{url}/rebuild").status_code == 404
        assert client.get(url).json()["rebuild"]["status"] == "cancelled"


def test_the_worker_runs_rebuilds_by_itself(open_service):
    provider, rebuilds = open_service()
    remember(provider, "a", "记忆")
    rebuilds.start_worker()
    try:
        rebuilds.start(GEMINI)
        deadline = time.monotonic() + 10
        while provider.space != GEMINI:
            assert time.monotonic() < deadline
            time.sleep(0.05)
    finally:
        rebuilds.stop()
