import itertools
import json
import uuid

import pytest
from starlette.testclient import TestClient

from axp_memory import mem0_provider
from axp_memory.app import create_app
from axp_memory.provider import Memory


class FakeProvider:
    """Keeps memories in a dict; search matches words, scored by the test."""

    def __init__(self):
        self.memories: dict[str, tuple[str, str]] = {}
        self.created: dict[str, str] = {}
        self.sources: dict[str, str] = {}
        self.extractions: list[tuple[str, list, str | None]] = []
        self.scores: dict[str, float] = {}
        self.clock = itertools.count()

    def add(self, agent_id, messages, *, source, infer, model=None):
        if infer:
            self.extractions.append((agent_id, messages, model))
            texts = [f"fact: {m['content']}" for m in messages if m["role"] == "user"]
        else:
            texts = [m["content"] for m in messages]
        added = []
        for text in texts:
            memory_id = str(uuid.uuid4())
            self.memories[memory_id] = (agent_id, text)
            self.created[memory_id] = f"2026-10-08T00:00:{next(self.clock):02d}+00:00"
            self.sources[memory_id] = source
            added.append(
                Memory(
                    memory_id, text, created_at=self.created[memory_id], source=source
                )
            )
        return added

    def search(self, agent_id, query, limit):
        found = [
            Memory(memory_id, text, self.scores.get(text, 0.9))
            for memory_id, (owner, text) in self.memories.items()
            if owner == agent_id and any(w in text for w in query.split())
        ]
        return found[:limit]

    def list(self, agent_id):
        return [
            Memory(
                memory_id,
                text,
                created_at=self.created[memory_id],
                source=self.sources[memory_id],
            )
            for memory_id, (owner, text) in self.memories.items()
            if owner == agent_id
        ]

    def delete(self, agent_id, memory_id):
        if self.memories.get(memory_id, ("",))[0] != agent_id:
            return False
        del self.memories[memory_id]
        return True


@pytest.fixture
def provider():
    return FakeProvider()


@pytest.fixture
def client(provider):
    with TestClient(create_app(provider)) as client:
        yield client


def as_agent(agent):
    return {"X-AXP-Agent-Id": agent}


def call_tool(client, agent, name, **arguments):
    response = client.post(
        "/memory/mcp",
        headers={
            **as_agent(agent),
            "Accept": "application/json, text/event-stream",
        },
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["result"]


class TestTools:
    def test_remember_then_recall(self, client):
        remembered = call_tool(client, "a", "remember", text="猫 叫豆豆")
        assert json.loads(remembered["content"][0]["text"])["text"] == "猫 叫豆豆"
        found = call_tool(client, "a", "recall", query="猫")
        [memory] = found["structuredContent"]["result"]
        assert memory["text"] == "猫 叫豆豆"

    def test_agents_only_see_their_own(self, client, provider):
        call_tool(client, "a", "remember", text="secret of a")
        assert call_tool(client, "b", "recall", query="secret")[
            "structuredContent"
        ] == {"result": []}
        [memory_id] = provider.memories
        result = call_tool(client, "b", "forget", memory_id=memory_id)
        assert result["isError"]
        assert memory_id in provider.memories
        call_tool(client, "a", "forget", memory_id=memory_id)
        assert provider.memories == {}

    def test_tools_need_the_gateway_header(self, client):
        response = client.post(
            "/memory/mcp",
            headers={"Accept": "application/json, text/event-stream"},
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "recall", "arguments": {"query": "x"}},
            },
        )
        assert response.json()["result"]["isError"]


class TestHooks:
    def test_recall_returns_relevant_memories(self, client, provider):
        call_tool(client, "a", "remember", text="deploy uses Kamal")
        call_tool(client, "a", "remember", text="deploy maybe unrelated")
        provider.scores["deploy maybe unrelated"] = 0.05
        response = client.post(
            "/memory/recall", headers=as_agent("a"), json={"query": "deploy"}
        )
        assert [m["text"] for m in response.json()["memories"]] == ["deploy uses Kamal"]
        empty = client.post(
            "/memory/recall", headers=as_agent("b"), json={"query": "deploy"}
        )
        assert empty.json() == {"memories": []}

    def test_capture_extracts_in_the_background(self, client, provider):
        response = client.post(
            "/memory/capture",
            headers=as_agent("a"),
            json={
                "model": "gpt-x",
                "messages": [
                    {"role": "user", "content": "I like Go"},
                    {"role": "assistant", "content": "Noted"},
                    {"role": "system", "content": "dropped"},
                ],
            },
        )
        assert response.status_code == 202
        client.app.state.captures.queue.join()
        assert provider.extractions == [
            (
                "a",
                [
                    {"role": "user", "content": "I like Go"},
                    {"role": "assistant", "content": "Noted"},
                ],
                "gpt-x",
            )
        ]

    def test_hooks_need_the_gateway_header(self, client):
        assert client.post("/memory/recall", json={"query": "x"}).status_code == 401
        assert client.post("/memory/capture", json={"messages": []}).status_code == 401


class TestBrowserApi:
    def url(self, agent, memory_id=""):
        path = f"/api/memory/v1/agents/{agent}/memories"
        return f"{path}/{memory_id}" if memory_id else path

    def test_add_list_search_delete(self, client, provider):
        first = client.post(self.url("a"), json={"text": "猫 叫豆豆"})
        assert first.status_code == 201
        client.post(self.url("a"), json={"text": "deploy uses Kamal"})
        client.post(self.url("b"), json={"text": "猫 of b"})

        listed = client.get(self.url("a")).json()["memories"]
        assert [m["text"] for m in listed] == ["deploy uses Kamal", "猫 叫豆豆"]
        assert all("created_at" in m for m in listed)

        found = client.get(self.url("a"), params={"q": "猫"}).json()["memories"]
        assert [m["text"] for m in found] == ["猫 叫豆豆"]
        assert found[0]["score"] == 0.9
        provider.scores["猫 叫豆豆"] = 0.05
        assert client.get(self.url("a"), params={"q": "猫"}).json() == {"memories": []}

        memory_id = first.json()["id"]
        assert client.delete(self.url("b", memory_id)).status_code == 404
        assert client.delete(self.url("a", memory_id)).status_code == 204
        assert [m["text"] for m in client.get(self.url("a")).json()["memories"]] == [
            "deploy uses Kamal"
        ]

    def test_memories_keep_their_source(self, client):
        added = client.post(self.url("a"), json={"text": "by the user"}).json()
        assert added["source"] == "user"
        assert "created_at" in added
        call_tool(client, "a", "remember", text="by the agent")
        client.post(
            "/memory/capture",
            headers=as_agent("a"),
            json={"messages": [{"role": "user", "content": "in a turn"}]},
        )
        client.app.state.captures.queue.join()
        listed = client.get(self.url("a")).json()["memories"]
        assert {m["text"]: m["source"] for m in listed} == {
            "by the user": "user",
            "by the agent": "agent",
            "fact: in a turn": "conversation",
        }

    def test_add_needs_text(self, client):
        response = client.post(self.url("a"), json={"text": "  "})
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "INVALID_TEXT"


class TestMem0Provider:
    def test_add_records_the_source(self):
        class Store:
            def add(self, messages, *, user_id, infer, metadata):
                self.metadata = metadata
                return {"results": [{"id": "m1", "memory": "x", "event": "ADD"}]}

        provider = mem0_provider.Mem0Provider.__new__(mem0_provider.Mem0Provider)
        provider.memory = Store()
        [added] = provider.add(
            "a", [{"role": "user", "content": "x"}], source="user", infer=False
        )
        assert provider.memory.metadata["source"] == "user"
        assert added.source == "user"
        assert added.created_at == provider.memory.metadata["created_at"]
        stored = {"id": "m1", "memory": "x", "metadata": {"source": "agent"}}
        assert mem0_provider._memory(stored).source == "agent"
        assert mem0_provider._memory({"id": "m2", "memory": "y"}).source is None

    def test_delete_checks_the_owner(self):
        class Store:
            deleted = []

            def get(self, memory_id):
                return {"id": memory_id, "user_id": "a"}

            def delete(self, memory_id):
                self.deleted.append(memory_id)

        provider = mem0_provider.Mem0Provider.__new__(mem0_provider.Mem0Provider)
        provider.memory = Store()
        memory_id = str(uuid.uuid4())
        assert not provider.delete("b", memory_id)
        assert not provider.delete("a", "not-a-uuid")
        assert provider.delete("a", memory_id)
        assert Store.deleted == [memory_id]


def test_up(client):
    assert client.get("/up").status_code == 204
