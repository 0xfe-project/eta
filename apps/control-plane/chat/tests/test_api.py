import uuid
from unittest import mock

import pytest
from dirty_equals import IsPartialDict, IsStr
from django.core.signals import request_finished
from django.db import close_old_connections

from chat import cursors, llm, queue
from chat.models import (
    Agent,
    AgentCommand,
    ApiIdempotency,
    Conversation,
    Message,
    UiEvent,
)
from chat.stream import event_stream

from .helpers import ChatClient, assert_no_internal_fields, error_of

pytestmark = pytest.mark.django_db


def close_stream(response):
    # Like Django's test client: closing must not drop the test transaction.
    request_finished.disconnect(close_old_connections)
    try:
        response.close()
    finally:
        request_finished.connect(close_old_connections)


def first_text(page):
    return page["items"][0]["blocks"][0]["text"]


class TestErrors:
    def test_error_envelope(self, chat):
        response = chat.post("/chat/messages/not-a-reply/stop")
        assert response.status_code == 404
        assert response.json()["error"] == {
            "code": "NOT_FOUND",
            "message": IsStr,
            "request_id": response["X-Request-ID"],
        }

    def test_malformed_json_is_400(self, chat):
        response = chat.client.post(
            "/api/v1/agents",
            data="{",
            content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="k",
        )
        assert error_of(response) == (400, "BAD_REQUEST")


class TestRequestId:
    def test_keeps_gateway_request_id(self, client):
        response = client.get("/api/health", HTTP_X_REQUEST_ID="gateway-request-1")
        assert response["X-Request-ID"] == "gateway-request-1"


class TestSnapshot:
    def test_empty_snapshot_has_no_side_effects(self, chat):
        response = chat.get("/chat")
        assert response.status_code == 200
        assert response.json() == IsPartialDict(
            agents=[],
            active_replies=[],
            event_cursor=IsStr(min_length=1),
        )
        assert not Conversation.objects.exists()

    def test_snapshot_contains_agents_and_active_replies(self, chat, agent):
        sent = chat.send(agent["id"])
        body = chat.get("/chat").json()
        assert [(a["id"], a["status"]) for a in body["agents"]] == [
            (agent["id"], "working")
        ]
        assert [m["id"] for m in body["active_replies"]] == [sent["reply"]["id"]]
        assert "messages" not in body
        assert_no_internal_fields(body)


class TestHistory:
    def test_pages_backwards_in_send_order(self, chat, agent, monkeypatch):
        monkeypatch.setattr(queue, "MAX_QUEUED_PER_AGENT", 100)
        for i in range(30):
            chat.send(agent["id"], f"m{i}")  # 60 messages
        path = f"/agents/{agent['id']}/messages"
        latest = chat.get(path).json()
        assert len(latest["items"]) == 50
        assert first_text(latest) == "m5"
        assert latest["items"][1]["role"] == "assistant"
        page = chat.get(path, data={"before": latest["next_cursor"]}).json()
        assert len(page["items"]) == 10
        assert page["next_cursor"] is None
        assert first_text(page) == "m0"
        assert_no_internal_fields(latest)

        small = chat.get(path, data={"limit": 4}).json()
        older = chat.get(path, data={"limit": 4, "before": small["next_cursor"]}).json()
        assert first_text(small) == "m28"
        assert first_text(older) == "m26"
        assert chat.get(path, data={"limit": 101}).status_code == 422

    def test_only_that_agents_messages(self, chat, agent):
        other = chat.create_agent("其他")
        mine = chat.send(agent["id"], "mine")
        chat.send(other["id"], "theirs")
        page = chat.get(f"/agents/{agent['id']}/messages").json()
        assert [m["id"] for m in page["items"]] == [
            mine["message"]["id"],
            mine["reply"]["id"],
        ]
        assert page["next_cursor"] is None

    def test_unknown_or_deleted_agent_is_404(self, chat, agent):
        assert chat.get(f"/agents/{uuid.uuid4()}/messages").status_code == 404
        assert chat.get("/agents/not-a-uuid/messages").status_code == 404
        chat.delete(f"/agents/{agent['id']}")
        assert chat.get(f"/agents/{agent['id']}/messages").status_code == 404

    def test_tampered_cursor_rejected(self, chat, agent):
        cursor = cursors.encode_history_cursor(10) + "x"
        response = chat.get(f"/agents/{agent['id']}/messages", data={"before": cursor})
        assert response.status_code == 400


class TestAgents:
    def test_create_agent_returns_product_fields_only(self, chat):
        agent = chat.create_agent("  开发助手  ")
        assert agent == {
            "id": IsStr,
            "name": "开发助手",
            "description": "",
            "model": "test-model",
            "plugins": ["tasks", "memory", "grok"],
            "status": "idle",
            "revision": 1,
        }

    def test_agents_share_one_default_conversation(self, chat):
        chat.create_agent("a")
        chat.create_agent("b")
        assert Conversation.objects.get().is_default

    @pytest.mark.parametrize(
        "body",
        [
            {"name": "   "},
            {"name": "x" * 101},
            {"name": "a", "model": ""},
            {"name": "a", "engine": "x"},
            {},
        ],
    )
    def test_validation(self, chat, body):
        assert chat.post("/agents", body).status_code == 422


CATALOG = [
    {
        "id": "gpt-5.5",
        "connector": "codex",
        "display_name": "GPT 5.5",
        "context_window": 272000,
        "available": True,
    },
    {
        "id": "grok-4",
        "connector": "xai",
        "display_name": "Grok 4",
        "available": False,
        "unavailable_message": "Grok 账号登录已失效，请重新登录。",
    },
]


class TestModels:
    @pytest.fixture(autouse=True)
    def _gateway(self):
        self.catalog = list(CATALOG)
        with mock.patch("chat.llm._fetch", side_effect=self.fetch):
            yield

    @pytest.fixture
    def agent(self, chat):
        return chat.create_agent(model=None)

    def fetch(self):
        if self.catalog is None:
            raise llm.GatewayUnavailable("down")
        return {
            m["id"]: llm.Model(
                id=m["id"],
                connector=m["connector"],
                display_name=m["display_name"],
                context_window=m.get("context_window"),
                available=m["available"],
                unavailable_message=m.get("unavailable_message"),
            )
            for m in self.catalog
        }

    def test_create_and_change_model(self, chat):
        response = chat.post("/agents", {"name": "a", "model": "gpt-5.5"})
        assert response.status_code == 201
        agent = response.json()
        assert agent["model"] == "gpt-5.5"
        before = Agent.objects.get(pk=agent["id"]).config_version
        response = chat.patch(f"/agents/{agent['id']}", {"model": "grok-4"})
        assert response.json()["model"] == "grok-4"
        # The runtime restarts with the new model.
        assert Agent.objects.get(pk=agent["id"]).config_version == before + 1

    def test_unknown_model_is_rejected(self, chat, agent):
        response = chat.post("/agents", {"name": "a", "model": "nope"})
        assert error_of(response) == (422, "MODEL_NOT_FOUND")
        response = chat.patch(f"/agents/{agent['id']}", {"model": "nope"})
        assert response.status_code == 422

    def test_chat_needs_an_available_model(self, chat, agent):
        body = {"agent_id": agent["id"], "text": "hi"}
        assert error_of(chat.post("/chat/messages", body)) == (409, "MODEL_NOT_SET")

        chat.patch(f"/agents/{agent['id']}", {"model": "grok-4"})
        response = chat.post("/chat/messages", body)
        assert error_of(response) == (409, "MODEL_UNAVAILABLE")
        assert "重新登录" in response.json()["error"]["message"]
        assert not Message.objects.exists()

        # Reconnecting the account makes the same model usable again.
        self.catalog[1] = {**self.catalog[1], "available": True}
        assert chat.post("/chat/messages", body).status_code == 202

    def test_gateway_down_blocks_chat(self, chat):
        agent = chat.post("/agents", {"name": "a", "model": "gpt-5.5"}).json()
        self.catalog = None
        response = chat.post("/chat/messages", {"agent_id": agent["id"], "text": "hi"})
        assert error_of(response) == (409, "MODEL_UNAVAILABLE")


class TestAgentManagement:
    @pytest.fixture
    def agent(self, chat):
        return chat.create_agent("旧名字")

    def test_create_with_description(self, chat, agent):
        instructions = "你是代码审查员。\n  只指出真实问题。"
        response = chat.post("/agents", {"name": "审查", "description": instructions})
        assert response.status_code == 201
        assert response.json()["description"] == instructions
        assert agent["description"] == ""
        too_long = {"name": "x", "description": "x" * 10_001}
        assert chat.post("/agents", too_long).status_code == 422

    def test_update_name_or_description_bumps_config_version(self, chat, agent):
        before = Agent.objects.get(pk=agent["id"]).config_version
        response = chat.patch(
            f"/agents/{agent['id']}", {"description": "只用中文回答。"}
        )
        assert response.json() == IsPartialDict(
            description="只用中文回答。", name="旧名字"
        )
        assert Agent.objects.get().config_version == before + 1
        # The name is part of the runtime's instructions too.
        chat.patch(f"/agents/{agent['id']}", {"name": "新"})
        assert Agent.objects.get().config_version == before + 2

    def test_plugins_are_chosen_from_the_catalog(self, chat, agent):
        assert [p["name"] for p in chat.get("/plugins").json()] == [
            "tasks",
            "memory",
            "grok",
        ]
        created = chat.post("/agents", {"name": "a", "plugins": ["grok", "tasks"]})
        # Catalog order, whatever order they were sent in.
        assert created.json()["plugins"] == ["tasks", "grok"]
        unknown = chat.post("/agents", {"name": "a", "plugins": ["nope"]})
        assert error_of(unknown) == (422, "PLUGIN_NOT_FOUND")

    def test_changing_plugins_bumps_config_version(self, chat, agent):
        before = Agent.objects.get(pk=agent["id"]).config_version
        response = chat.patch(f"/agents/{agent['id']}", {"plugins": []})
        assert response.json()["plugins"] == []
        assert Agent.objects.get().config_version == before + 1

    def test_rename(self, chat, agent):
        response = chat.patch(f"/agents/{agent['id']}", {"name": " 新名字 "})
        assert response.status_code == 200
        assert response.json() == IsPartialDict(
            name="新名字", revision=agent["revision"] + 1
        )
        event = UiEvent.objects.order_by("-seq").first()
        assert event.payload["agent"]["name"] == "新名字"
        assert chat.patch(f"/agents/{agent['id']}", {"name": ""}).status_code == 422
        missing = chat.patch(f"/agents/{uuid.uuid4()}", {"name": "x"})
        assert missing.status_code == 404

    def test_delete_hides_agent_keeps_history_and_stops_work(self, chat, agent):
        sent = chat.send(agent["id"])
        assert chat.delete(f"/agents/{agent['id']}").status_code == 204
        snapshot = chat.get("/chat").json()
        assert snapshot["agents"] == []
        statuses = dict(Message.objects.values_list("id", "status"))
        assert statuses[uuid.UUID(sent["reply"]["id"])] == "stopped"
        assert uuid.UUID(sent["message"]["id"]) in statuses
        event = UiEvent.objects.order_by("-seq").first()
        assert (event.type, event.payload) == (
            "agent.deleted",
            {"agent_id": agent["id"]},
        )
        assert Agent.objects.get().deleted_at is not None
        # A deleted agent cannot be used, renamed or deleted again.
        body = {"agent_id": agent["id"], "text": "hi"}
        assert chat.post("/chat/messages", body).status_code == 404
        assert chat.patch(f"/agents/{agent['id']}", {"name": "x"}).status_code == 404
        assert chat.delete(f"/agents/{agent['id']}").status_code == 404


class TestIdempotency:
    def test_same_key_replays_original_response(self, chat):
        first = chat.post("/agents", {"name": "a"}, key="k1")
        second = chat.post("/agents", {"name": "a"}, key="k1")
        assert second.status_code == 201
        assert first.json() == second.json()
        assert Conversation.objects.get().agents.count() == 1

    def test_same_key_different_body_conflicts(self, chat):
        chat.post("/agents", {"name": "a"}, key="k1")
        response = chat.post("/agents", {"name": "b"}, key="k1")
        assert error_of(response) == (409, "IDEMPOTENCY_KEY_REUSED")

    def test_key_is_scoped_by_path(self, chat, agent):
        chat.post("/agents", {"name": "a"}, key="k1")
        body = {"agent_id": agent["id"], "text": "hi"}
        assert chat.post("/chat/messages", body, key="k1").status_code == 202

    def test_key_required(self, chat):
        response = chat.post("/agents", {"name": "a"}, key=None)
        assert error_of(response) == (400, "IDEMPOTENCY_KEY_REQUIRED")

    def test_failures_do_not_consume_key(self, chat):
        assert chat.post("/agents", {"name": ""}, key="k1").status_code == 422
        missing = {"agent_id": str(uuid.uuid4()), "text": "hi"}
        assert chat.post("/chat/messages", missing, key="k2").status_code == 404
        assert not ApiIdempotency.objects.exists()
        assert chat.post("/agents", {"name": "a"}, key="k1").status_code == 201

    def test_send_retry_returns_same_messages(self, chat, agent):
        body = {"agent_id": agent["id"], "text": "hi"}
        first = chat.post("/chat/messages", body, key="send-1").json()
        second = chat.post("/chat/messages", body, key="send-1").json()
        assert first == second
        assert AgentCommand.objects.count() == 1


class TestSendMessage:
    def test_send_returns_message_and_reply_placeholder(self, chat, agent):
        text = "  def f():\n      return 1"
        body = chat.send(agent["id"], text)
        message, reply = body["message"], body["reply"]
        assert message == IsPartialDict(
            role="user", status="completed", reply_to_id=None
        )
        assert message["blocks"][0]["text"] == text  # indentation kept
        assert reply == IsPartialDict(
            role="assistant", status="queued", reply_to_id=message["id"], blocks=[]
        )
        assert_no_internal_fields(body)

    @pytest.mark.parametrize("text", ["", "   \n\t", "x" * 10_001])
    def test_text_validation(self, chat, agent, text):
        body = {"agent_id": agent["id"], "text": text}
        assert chat.post("/chat/messages", body).status_code == 422

    @pytest.mark.parametrize("agent_id", [str(uuid.uuid4()), "not-a-uuid"])
    def test_unknown_agent_is_404(self, chat, agent_id):
        body = {"agent_id": agent_id, "text": "hi"}
        assert chat.post("/chat/messages", body).status_code == 404

    def test_queue_full_is_429(self, chat, agent, monkeypatch):
        monkeypatch.setattr(queue, "MAX_QUEUED_PER_AGENT", 2)
        chat.send(agent["id"])
        chat.send(agent["id"])
        response = chat.post("/chat/messages", {"agent_id": agent["id"], "text": "hi"})
        assert error_of(response) == (429, "QUEUE_FULL")

    def test_events_are_written_with_projection(self, chat, agent):
        sent = chat.send(agent["id"])
        events = list(UiEvent.objects.order_by("seq").values_list("type", "payload"))
        assert [t for t, _ in events] == [
            "agent.updated",
            "message.updated",
            "message.updated",
            "agent.updated",
        ]
        assert events[2][1]["message"] == sent["reply"]
        assert events[3][1]["agent"]["status"] == "working"
        for _, payload in events:
            assert_no_internal_fields(payload)


class TestStop:
    @pytest.fixture
    def sent(self, chat, agent):
        return chat.send(agent["id"])

    def test_stop_queued_reply_cancels(self, chat, sent):
        reply_id = sent["reply"]["id"]
        response = chat.post(f"/chat/messages/{reply_id}/stop")
        assert response.status_code == 200
        assert response.json()["status"] == "stopped"
        assert AgentCommand.objects.get().status == "cancelled"
        # Repeating is a no-op with a fresh key.
        assert chat.post(f"/chat/messages/{reply_id}/stop").json() == response.json()
        assert chat.get("/chat").json()["agents"][0]["status"] == "idle"

    def test_stop_only_targets_assistant_replies(self, chat, sent):
        message_id = sent["message"]["id"]
        assert chat.post(f"/chat/messages/{message_id}/stop").status_code == 404

    def test_stop_targets_only_that_reply(self, chat, agent, sent):
        second = chat.send(agent["id"])
        chat.post(f"/chat/messages/{sent['reply']['id']}/stop")
        page = chat.get(f"/agents/{agent['id']}/messages").json()
        replies = {m["id"]: m["status"] for m in page["items"]}
        assert replies[second["reply"]["id"]] == "queued"


def drain(seq):
    return "".join(event_stream(seq, poll_interval=0.001, max_idle_polls=1))


class TestStream:
    def test_initial_cursor_resumes_after_first_agent(self, chat):
        cursor = chat.get("/chat").json()["event_cursor"]
        agent = chat.create_agent()
        response = chat.get("/chat/stream", data={"cursor": cursor})
        assert response.status_code == 200
        assert response["Content-Type"] == "text/event-stream"
        assert response["Cache-Control"] == "no-cache"
        close_stream(response)
        output = drain(cursors.decode_event_cursor(cursor))
        assert "event: agent.updated" in output
        assert agent["id"] in output

    def test_resume_from_last_event_id(self, chat, agent):
        chat.send(agent["id"])
        output = drain(0)
        ids = [line[4:] for line in output.splitlines() if line.startswith("id: ")]
        assert len(ids) == 4
        rest = drain(cursors.decode_event_cursor(ids[1]))
        assert rest.count("event: ") == 2
        assert ": heartbeat" not in rest

    def test_header_takes_precedence_and_cursor_checks(self, chat, agent):
        tampered = cursors.encode_event_cursor(0) + "x"
        assert chat.get("/chat/stream", data={"cursor": tampered}).status_code == 400
        future = cursors.encode_event_cursor(999)
        response = chat.get("/chat/stream", data={"cursor": future})
        assert error_of(response) == (410, "CURSOR_EXPIRED")
        valid = cursors.encode_event_cursor(0)
        response = chat.get(
            "/chat/stream", data={"cursor": future}, HTTP_LAST_EVENT_ID=valid
        )
        assert response.status_code == 200
        close_stream(response)
        assert chat.get("/chat/stream").status_code == 400

    def test_heartbeat_has_no_id(self):
        output = "".join(
            event_stream(
                0, poll_interval=0.001, heartbeat_interval=0.0001, max_idle_polls=2
            )
        )
        assert ": heartbeat\n\n" in output
        assert "id:" not in output


def test_public_schema_has_no_internal_fields():
    schema = ChatClient().client.get("/api/openapi.json").json()
    assert {p for p in schema["paths"] if p.startswith("/api/v1")} == {
        "/api/v1/chat",
        "/api/v1/plugins",
        "/api/v1/agents",
        "/api/v1/agents/{agent_id}/messages",
        "/api/v1/agents/{agent_id}",
        "/api/v1/agents/{agent_id}/compact",
        "/api/v1/agents/{agent_id}/restart",
        "/api/v1/chat/messages",
        "/api/v1/chat/stream",
        "/api/v1/chat/messages/{message_id}/stop",
        "/api/v1/chat/interactions/{interaction_id}/answer",
    }
    properties = set()
    for component in schema["components"]["schemas"].values():
        properties |= set(component.get("properties", {}))
    assert_no_internal_fields(dict.fromkeys(properties))
