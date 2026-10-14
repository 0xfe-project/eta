import json
import os
import uuid
from types import SimpleNamespace

import httpx
import psycopg
import pytest
from openai import OpenAI
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool
from starlette.testclient import TestClient

from axp_memory import embedding, mem0_provider
from axp_memory.app import create_app
from axp_memory.reindex import reindex


@pytest.fixture
def pool():
    url = os.environ.get(
        "AXP_TEST_DATABASE_URL", "postgres://axp:axp@127.0.0.1:15432/axp"
    )
    schema = "memory_test_" + uuid.uuid4().hex
    with psycopg.connect(url, autocommit=True) as admin:
        admin.execute("CREATE EXTENSION IF NOT EXISTS vector")
        admin.execute(f"CREATE SCHEMA {schema}")
    try:
        with ConnectionPool(
            url, kwargs={"options": f"-c search_path={schema},public"}
        ) as pool:
            with pool.connection() as connection:
                for table in ("memories", "memories_entities"):
                    connection.execute(
                        f"CREATE TABLE {table} "
                        "(id uuid PRIMARY KEY, vector vector(3), payload jsonb)"
                    )
                    connection.execute(
                        f"CREATE INDEX {table}_hnsw_idx ON {table} "
                        "USING hnsw (vector vector_cosine_ops)"
                    )
                    for i in range(35):
                        connection.execute(
                            f"INSERT INTO {table} VALUES (%s, %s, %s)",
                            (
                                uuid.uuid4(),
                                [0.0, 1.0, 0.0],
                                Jsonb(
                                    {
                                        "data": f"fact {i}",
                                        "user_id": "a",
                                        "source_group_id": "g",
                                        "created_at": "2026-10-14",
                                    }
                                ),
                            ),
                        )
            yield pool
    finally:
        with psycopg.connect(url, autocommit=True) as admin:
            admin.execute(f"DROP SCHEMA {schema} CASCADE")


class Embedder:
    def __init__(self, dimensions=5, fail_after=None):
        self.config = SimpleNamespace(embedding_dims=dimensions)
        self.fingerprint = "new-model"
        self.calls = 0
        self.fail_after = fail_after

    def embed_batch(self, texts):
        self.calls += 1
        if self.fail_after is not None and self.calls > self.fail_after:
            raise RuntimeError("API unavailable")
        return [[1.0] + [0.0] * (self.config.embedding_dims - 1) for _ in texts]


def snapshot(pool):
    with pool.connection() as connection:
        return {
            table: connection.execute(
                f"SELECT id, payload FROM {table} ORDER BY id"
            ).fetchall()
            for table in ("memories", "memories_entities")
        }


def test_reembeds_legacy_memories_and_entities_preserving_ids_and_metadata(pool):
    before = snapshot(pool)
    model = Embedder()
    reindex(pool, model)
    assert snapshot(pool) == before
    with pool.connection() as connection:
        for table in before:
            assert connection.execute(
                f"SELECT DISTINCT vector_dims(vector) FROM {table}"
            ).fetchall() == [(5,)]
            assert (
                connection.execute(
                    f"SELECT vector::text FROM {table} LIMIT 1"
                ).fetchone()[0]
                == "[1,0,0,0,0]"
            )
    calls = model.calls
    reindex(pool, model)
    assert model.calls == calls


def test_failed_switch_rolls_back_vectors_dimensions_and_marker(pool):
    before = snapshot(pool)
    with pool.connection() as connection:
        connection.execute(
            "CREATE TABLE axp_embedding (singleton boolean PRIMARY KEY, "
            "fingerprint text, dimensions integer)"
        )
        connection.execute("INSERT INTO axp_embedding VALUES (true, 'previous', 3)")
    with pytest.raises(RuntimeError, match="unavailable"):
        reindex(pool, Embedder(fail_after=1))
    assert snapshot(pool) == before
    with pool.connection() as connection:
        assert connection.execute(
            "SELECT fingerprint, dimensions FROM axp_embedding"
        ).fetchone() == ("previous", 3)
        assert (
            connection.execute("SELECT vector::text FROM memories LIMIT 1").fetchone()[
                0
            ]
            == "[0,1,0]"
        )
        assert (
            connection.execute("SELECT to_regclass('memories_hnsw_idx')").fetchone()[0]
            is not None
        )


def test_external_api_through_http_mem0_and_pgvector(pool, monkeypatch):
    with pool.connection() as connection:
        connection.execute("DELETE FROM memories")
        connection.execute("DELETE FROM memories_entities")
    requests = []

    def handle(request):
        body = json.loads(request.content)
        requests.append(body)
        return httpx.Response(
            200,
            json={
                "data": [
                    {
                        "index": i,
                        "embedding": [1.0, 0.0, 0.0]
                        if "部署" in text
                        else [0.0, 1.0, 0.0],
                    }
                    for i, text in enumerate(body["input"])
                ]
            },
        )

    monkeypatch.setenv("MEMORY_EMBEDDING_URL", "http://example.com/v1")
    monkeypatch.setenv("MEMORY_EMBEDDING_MODEL", "native")
    monkeypatch.setattr(
        embedding,
        "OpenAI",
        lambda **kwargs: OpenAI(
            **kwargs, http_client=httpx.Client(transport=httpx.MockTransport(handle))
        ),
    )

    class Pool:
        check_connection = staticmethod(ConnectionPool.check_connection)

        def __new__(cls, *args, **kwargs):
            return pool

    monkeypatch.setattr(mem0_provider, "ConnectionPool", Pool)
    provider = mem0_provider.Mem0Provider("unused", "http://llm.example/v1", "unused")
    with TestClient(create_app(provider)) as client:
        added = client.post(
            "/api/memory/v1/agents/a/memories", json={"text": "部署需要确认"}
        )
        assert added.status_code == 201
        assert (
            client.post(
                "/api/memory/v1/agents/a/memories", json={"text": "偏好中文交流"}
            ).status_code
            == 201
        )
        recalled = client.post(
            "/memory/recall",
            headers={"X-AXP-Agent-Id": "a"},
            json={"query": "部署"},
        ).json()["memories"]
        assert recalled[0]["id"] == added.json()["id"]
        assert (
            client.post(
                "/memory/recall",
                headers={"X-AXP-Agent-Id": "b"},
                json={"query": "部署"},
            ).json()["memories"]
            == []
        )
        assert (
            client.delete(
                f"/api/memory/v1/agents/b/memories/{added.json()['id']}"
            ).status_code
            == 404
        )
        assert (
            client.delete(
                f"/api/memory/v1/agents/a/memories/{added.json()['id']}"
            ).status_code
            == 204
        )
    assert all(request["model"] == "native" for request in requests)
    assert all("dimensions" not in request for request in requests)
    provider.memory.llm.client.close()
    provider.memory.embedding_model.client.close()


def test_native_dimensions_above_hnsw_limit_use_exact_search(pool):
    reindex(pool, Embedder(dimensions=2048))
    with pool.connection() as connection:
        assert connection.execute(
            "SELECT DISTINCT vector_dims(vector) FROM memories"
        ).fetchall() == [(2048,)]
        assert (
            connection.execute(
                "SELECT to_regclass(current_schema() || '.memories_hnsw_idx')"
            ).fetchone()[0]
            is None
        )
