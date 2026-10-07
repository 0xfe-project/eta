import uuid

from django.core.signals import request_finished
from django.db import close_old_connections
from django.test import TestCase, override_settings

from chat import cursors
from chat.models import Agent, AgentCommand, ApiIdempotency, Conversation, UiEvent
from chat.stream import event_stream

from .helpers import ChatClient, assert_no_internal_fields


def close_stream(response):
    # Like Django's test client: closing must not drop the test transaction.
    request_finished.disconnect(close_old_connections)
    try:
        response.close()
    finally:
        request_finished.connect(close_old_connections)


class ErrorTests(TestCase):
    def test_error_envelope(self):
        response = ChatClient().post("/chat/messages/not-a-reply/stop")
        self.assertEqual(response.status_code, 404)
        error = response.json()["error"]
        self.assertEqual(error["code"], "NOT_FOUND")
        self.assertEqual(error["request_id"], response["X-Request-ID"])
        self.assertEqual(set(error), {"code", "message", "request_id"})

    def test_malformed_json_is_400(self):
        response = ChatClient().client.post(
            "/api/v1/agents",
            data="{",
            content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="k",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "BAD_REQUEST")


@override_settings(AXP_EDGE_SECRET="s3cret")
class EdgeSecretTests(TestCase):
    def test_requires_gateway_secret(self):
        response = self.client.get("/api/v1/chat")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "FORBIDDEN")
        response = self.client.get("/api/v1/chat", HTTP_X_AXP_EDGE_SECRET="wrong")
        self.assertEqual(response.status_code, 403)
        response = self.client.get("/api/v1/chat", HTTP_X_AXP_EDGE_SECRET="s3cret")
        self.assertEqual(response.status_code, 200)

    def test_health_stays_open(self):
        self.assertEqual(self.client.get("/api/health").status_code, 200)

    def test_keeps_gateway_request_id(self):
        response = self.client.get("/api/health", HTTP_X_REQUEST_ID="gateway-request-1")
        self.assertEqual(response["X-Request-ID"], "gateway-request-1")


class SnapshotTests(TestCase):
    def setUp(self):
        self.chat = ChatClient()

    def test_empty_snapshot_has_no_side_effects(self):
        response = self.chat.get("/chat")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["agents"], [])
        self.assertEqual(body["messages"], [])
        self.assertIsNone(body["history_cursor"])
        self.assertTrue(body["event_cursor"])
        self.assertFalse(Conversation.objects.exists())

    def test_snapshot_contains_agents_messages_and_active_replies(self):
        agent = self.chat.create_agent()
        sent = self.chat.send(agent["id"])
        body = self.chat.get("/chat").json()
        self.assertEqual([a["id"] for a in body["agents"]], [agent["id"]])
        self.assertEqual(body["agents"][0]["status"], "working")
        self.assertEqual(
            [m["id"] for m in body["messages"]],
            [sent["message"]["id"], sent["reply"]["id"]],
        )
        self.assertEqual(
            [m["id"] for m in body["active_replies"]], [sent["reply"]["id"]]
        )
        assert_no_internal_fields(self, body)

    @override_settings(CHAT_MAX_QUEUED_PER_AGENT=100)
    def test_history_pagination(self):
        agent = self.chat.create_agent()
        for i in range(30):
            self.chat.send(agent["id"], f"m{i}")  # 60 messages
        snapshot = self.chat.get("/chat").json()
        self.assertEqual(len(snapshot["messages"]), 50)
        self.assertIsNotNone(snapshot["history_cursor"])
        page = self.chat.get(
            "/chat/messages", data={"before": snapshot["history_cursor"]}
        ).json()
        self.assertEqual(len(page["items"]), 10)
        self.assertIsNone(page["next_cursor"])
        self.assertEqual(page["items"][0]["blocks"][0]["text"], "m0")

        small = self.chat.get("/chat/messages", data={"limit": 4}).json()
        self.assertEqual(len(small["items"]), 4)
        older = self.chat.get(
            "/chat/messages", data={"limit": 4, "before": small["next_cursor"]}
        ).json()
        self.assertEqual(small["items"][0]["blocks"][0]["text"], "m28")
        self.assertEqual(older["items"][0]["blocks"][0]["text"], "m26")
        self.assertEqual(
            self.chat.get("/chat/messages", data={"limit": 101}).status_code, 422
        )

    def test_tampered_history_cursor_rejected(self):
        cursor = cursors.encode_history_cursor(10) + "x"
        response = self.chat.get("/chat/messages", data={"before": cursor})
        self.assertEqual(response.status_code, 400)


class AgentTests(TestCase):
    def setUp(self):
        self.chat = ChatClient()

    def test_create_agent_returns_product_fields_only(self):
        agent = self.chat.create_agent("  开发助手  ")
        self.assertEqual(
            set(agent), {"id", "name", "description", "status", "revision"}
        )
        self.assertEqual(agent["name"], "开发助手")
        self.assertEqual(agent["status"], "idle")

    def test_agents_share_one_default_conversation(self):
        self.chat.create_agent("a")
        self.chat.create_agent("b")
        self.assertEqual(Conversation.objects.count(), 1)
        self.assertTrue(Conversation.objects.get().is_default)

    def test_validation(self):
        for body in (
            {"name": "   "},
            {"name": "x" * 101},
            {"name": "a", "model": "x"},
            {},
        ):
            with self.subTest(body=body):
                self.assertEqual(self.chat.post("/agents", body).status_code, 422)


class AgentManagementTests(TestCase):
    def setUp(self):
        self.chat = ChatClient()
        self.agent = self.chat.create_agent("旧名字")

    def test_create_with_description(self):
        instructions = "你是代码审查员。\n  只指出真实问题。"
        response = self.chat.post(
            "/agents", {"name": "审查", "description": instructions}
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["description"], instructions)
        self.assertEqual(self.agent["description"], "")
        too_long = {"name": "x", "description": "x" * 10_001}
        self.assertEqual(self.chat.post("/agents", too_long).status_code, 422)

    def test_update_description_bumps_config_version(self):
        before = Agent.objects.get(pk=self.agent["id"]).config_version
        response = self.chat.patch(
            f"/agents/{self.agent['id']}", {"description": "只用中文回答。"}
        )
        self.assertEqual(response.json()["description"], "只用中文回答。")
        self.assertEqual(response.json()["name"], "旧名字")
        agent = Agent.objects.get(pk=self.agent["id"])
        self.assertEqual(agent.config_version, before + 1)
        # Renaming alone does not touch runtime configuration.
        self.chat.patch(f"/agents/{self.agent['id']}", {"name": "新"})
        self.assertEqual(Agent.objects.get().config_version, before + 1)
        unknown = self.chat.patch(f"/agents/{self.agent['id']}", {"model": "x"})
        self.assertEqual(unknown.status_code, 422)

    def test_rename(self):
        response = self.chat.patch(f"/agents/{self.agent['id']}", {"name": " 新名字 "})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["name"], "新名字")
        self.assertEqual(response.json()["revision"], self.agent["revision"] + 1)
        event = UiEvent.objects.order_by("-seq").first()
        self.assertEqual(event.payload["agent"]["name"], "新名字")
        self.assertEqual(
            self.chat.patch(f"/agents/{self.agent['id']}", {"name": ""}).status_code,
            422,
        )
        missing = self.chat.patch(f"/agents/{uuid.uuid4()}", {"name": "x"})
        self.assertEqual(missing.status_code, 404)

    def test_delete_hides_agent_keeps_history_and_stops_work(self):
        sent = self.chat.send(self.agent["id"])
        response = self.chat.delete(f"/agents/{self.agent['id']}")
        self.assertEqual(response.status_code, 204)
        snapshot = self.chat.get("/chat").json()
        self.assertEqual(snapshot["agents"], [])
        statuses = {m["id"]: m["status"] for m in snapshot["messages"]}
        self.assertEqual(statuses[sent["reply"]["id"]], "stopped")
        self.assertIn(sent["message"]["id"], statuses)
        event = UiEvent.objects.order_by("-seq").first()
        self.assertEqual(event.type, "agent.deleted")
        self.assertEqual(event.payload, {"agent_id": self.agent["id"]})
        self.assertIsNotNone(Agent.objects.get().deleted_at)
        # A deleted agent cannot be used, renamed or deleted again.
        body = {"agent_id": self.agent["id"], "text": "hi"}
        self.assertEqual(self.chat.post("/chat/messages", body).status_code, 404)
        self.assertEqual(
            self.chat.patch(f"/agents/{self.agent['id']}", {"name": "x"}).status_code,
            404,
        )
        self.assertEqual(
            self.chat.delete(f"/agents/{self.agent['id']}").status_code, 404
        )


class IdempotencyTests(TestCase):
    def setUp(self):
        self.chat = ChatClient()

    def test_same_key_replays_original_response(self):
        first = self.chat.post("/agents", {"name": "a"}, key="k1")
        second = self.chat.post("/agents", {"name": "a"}, key="k1")
        self.assertEqual(second.status_code, 201)
        self.assertEqual(first.json(), second.json())
        self.assertEqual(Conversation.objects.get().agents.count(), 1)

    def test_same_key_different_body_conflicts(self):
        self.chat.post("/agents", {"name": "a"}, key="k1")
        response = self.chat.post("/agents", {"name": "b"}, key="k1")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "IDEMPOTENCY_KEY_REUSED")

    def test_key_is_scoped_by_path(self):
        agent = self.chat.create_agent()
        self.chat.post("/agents", {"name": "a"}, key="k1")
        body = {"agent_id": agent["id"], "text": "hi"}
        self.assertEqual(
            self.chat.post("/chat/messages", body, key="k1").status_code, 202
        )

    def test_key_required(self):
        response = self.chat.post("/agents", {"name": "a"}, key=None)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "IDEMPOTENCY_KEY_REQUIRED")

    def test_failures_do_not_consume_key(self):
        self.assertEqual(
            self.chat.post("/agents", {"name": ""}, key="k1").status_code, 422
        )
        missing = {"agent_id": str(uuid.uuid4()), "text": "hi"}
        self.assertEqual(
            self.chat.post("/chat/messages", missing, key="k2").status_code, 404
        )
        self.assertFalse(ApiIdempotency.objects.exists())
        self.assertEqual(
            self.chat.post("/agents", {"name": "a"}, key="k1").status_code, 201
        )

    def test_send_retry_returns_same_messages(self):
        agent = self.chat.create_agent()
        body = {"agent_id": agent["id"], "text": "hi"}
        first = self.chat.post("/chat/messages", body, key="send-1").json()
        second = self.chat.post("/chat/messages", body, key="send-1").json()
        self.assertEqual(first, second)
        self.assertEqual(AgentCommand.objects.count(), 1)


class SendMessageTests(TestCase):
    def setUp(self):
        self.chat = ChatClient()
        self.agent = self.chat.create_agent()

    def test_send_returns_message_and_reply_placeholder(self):
        text = "  def f():\n      return 1"
        body = self.chat.send(self.agent["id"], text)
        message, reply = body["message"], body["reply"]
        self.assertEqual(message["role"], "user")
        self.assertEqual(message["status"], "completed")
        self.assertIsNone(message["reply_to_id"])
        self.assertEqual(message["blocks"][0]["text"], text)  # indentation kept
        self.assertEqual(reply["role"], "assistant")
        self.assertEqual(reply["status"], "queued")
        self.assertEqual(reply["reply_to_id"], message["id"])
        self.assertEqual(reply["blocks"], [])
        assert_no_internal_fields(self, body)

    def test_text_validation(self):
        for text in ("", "   \n\t", "x" * 10_001):
            with self.subTest(text=text[:5]):
                response = self.chat.post(
                    "/chat/messages", {"agent_id": self.agent["id"], "text": text}
                )
                self.assertEqual(response.status_code, 422)

    def test_unknown_agent_is_404(self):
        missing = {"agent_id": str(uuid.uuid4()), "text": "hi"}
        self.assertEqual(self.chat.post("/chat/messages", missing).status_code, 404)
        bad = self.chat.post("/chat/messages", {"agent_id": "not-a-uuid", "text": "hi"})
        self.assertEqual(bad.status_code, 404)

    @override_settings(CHAT_MAX_QUEUED_PER_AGENT=2)
    def test_queue_full_is_429(self):
        self.chat.send(self.agent["id"])
        self.chat.send(self.agent["id"])
        response = self.chat.post(
            "/chat/messages", {"agent_id": self.agent["id"], "text": "hi"}
        )
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json()["error"]["code"], "QUEUE_FULL")

    def test_events_are_written_with_projection(self):
        sent = self.chat.send(self.agent["id"])
        events = list(UiEvent.objects.order_by("seq").values_list("type", "payload"))
        types = [t for t, _ in events]
        self.assertEqual(
            types,
            ["agent.updated", "message.updated", "message.updated", "agent.updated"],
        )
        self.assertEqual(events[2][1]["message"], sent["reply"])
        self.assertEqual(events[3][1]["agent"]["status"], "working")
        for _, payload in events:
            assert_no_internal_fields(self, payload)


class StopTests(TestCase):
    def setUp(self):
        self.chat = ChatClient()
        self.agent = self.chat.create_agent()
        self.sent = self.chat.send(self.agent["id"])

    def test_stop_queued_reply_cancels(self):
        reply_id = self.sent["reply"]["id"]
        response = self.chat.post(f"/chat/messages/{reply_id}/stop")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "stopped")
        self.assertEqual(AgentCommand.objects.get().status, "cancelled")
        # Repeating is a no-op with a fresh key.
        again = self.chat.post(f"/chat/messages/{reply_id}/stop").json()
        self.assertEqual(again, response.json())
        agent = self.chat.get("/chat").json()["agents"][0]
        self.assertEqual(agent["status"], "idle")

    def test_stop_only_targets_assistant_replies(self):
        message_id = self.sent["message"]["id"]
        self.assertEqual(
            self.chat.post(f"/chat/messages/{message_id}/stop").status_code, 404
        )

    def test_stop_targets_only_that_reply(self):
        second = self.chat.send(self.agent["id"])
        self.chat.post(f"/chat/messages/{self.sent['reply']['id']}/stop")
        replies = {
            m["id"]: m["status"] for m in self.chat.get("/chat").json()["messages"]
        }
        self.assertEqual(replies[second["reply"]["id"]], "queued")


class StreamTests(TestCase):
    def setUp(self):
        self.chat = ChatClient()

    def _drain(self, seq):
        return "".join(event_stream(seq, poll_interval=0.001, max_idle_polls=1))

    def test_initial_cursor_resumes_after_first_agent(self):
        cursor = self.chat.get("/chat").json()["event_cursor"]
        agent = self.chat.create_agent()
        response = self.chat.get("/chat/stream", data={"cursor": cursor})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "text/event-stream")
        self.assertEqual(response["Cache-Control"], "no-cache")
        close_stream(response)
        output = self._drain(cursors.decode_event_cursor(cursor))
        self.assertIn("event: agent.updated", output)
        self.assertIn(agent["id"], output)

    def test_resume_from_last_event_id(self):
        agent = self.chat.create_agent()
        self.chat.send(agent["id"])
        output = self._drain(0)
        ids = [line[4:] for line in output.splitlines() if line.startswith("id: ")]
        self.assertEqual(len(ids), 4)
        rest = self._drain(cursors.decode_event_cursor(ids[1]))
        self.assertEqual(rest.count("event: "), 2)
        self.assertNotIn(": heartbeat", rest)

    def test_header_takes_precedence_and_cursor_checks(self):
        self.chat.create_agent()
        tampered = cursors.encode_event_cursor(0) + "x"
        response = self.chat.get("/chat/stream", data={"cursor": tampered})
        self.assertEqual(response.status_code, 400)
        future = cursors.encode_event_cursor(999)
        response = self.chat.get("/chat/stream", data={"cursor": future})
        self.assertEqual(response.status_code, 410)
        self.assertEqual(response.json()["error"]["code"], "CURSOR_EXPIRED")
        valid = cursors.encode_event_cursor(0)
        response = self.chat.get(
            "/chat/stream", data={"cursor": future}, HTTP_LAST_EVENT_ID=valid
        )
        self.assertEqual(response.status_code, 200)
        close_stream(response)
        self.assertEqual(self.chat.get("/chat/stream").status_code, 400)

    def test_heartbeat_has_no_id(self):
        output = "".join(
            event_stream(
                0,
                poll_interval=0.001,
                heartbeat_interval=0.0001,
                max_idle_polls=2,
            )
        )
        self.assertIn(": heartbeat\n\n", output)
        self.assertNotIn("id:", output)


class OpenApiTests(TestCase):
    def test_public_schema_has_no_internal_fields(self):
        schema = ChatClient().client.get("/api/openapi.json").json()
        paths = {p for p in schema["paths"] if p.startswith("/api/v1")}
        self.assertEqual(
            paths,
            {
                "/api/v1/chat",
                "/api/v1/agents",
                "/api/v1/agents/{agent_id}",
                "/api/v1/chat/messages",
                "/api/v1/chat/stream",
                "/api/v1/chat/messages/{message_id}/stop",
                "/api/v1/chat/interactions/{interaction_id}/answer",
            },
        )
        properties = set()
        for component in schema["components"]["schemas"].values():
            properties |= set(component.get("properties", {}))
        assert_no_internal_fields(self, {key: None for key in properties})
