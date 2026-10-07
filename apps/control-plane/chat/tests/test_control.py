import hashlib
import json
import shutil
import tempfile
import uuid
from datetime import timedelta
from pathlib import Path
from unittest import mock

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from chat.control import mcp
from chat.control.auth import runtime_token
from chat.control.controller import Controller
from chat.control.driver import StartedRuntime
from chat.control.objects import object_store
from chat.control.runtime_client import RuntimeUnavailable
from chat.models import (
    Agent,
    AgentCheckpoint,
    AgentCommand,
    AgentSession,
    Approval,
    Interaction,
    McpModuleRevision,
    Message,
    RuntimeInstance,
)

from .helpers import ChatClient, assert_no_internal_fields


class FakeDriver:
    def __init__(self):
        self.started = []
        self.stopped = []
        self.volumes = set()
        self.states = {}
        self.fail_start = False

    def volume_exists(self, name):
        return name in self.volumes

    def ensure_volume(self, name):
        self.volumes.add(name)

    def start(self, spec):
        if self.fail_start:
            raise RuntimeError("docker down")
        self.started.append(spec)
        container_id = uuid.uuid4().hex
        self.states[container_id] = "running"
        return StartedRuntime(container_id, f"http://runtime-{spec.generation}", "sha")

    def state(self, container_id):
        return self.states.get(container_id, "missing")

    def stop(self, container_id, timeout=10):
        self.stopped.append(container_id)
        self.states[container_id] = "exited"


class FakeClients:
    """Stands in for RuntimeClient; records calls per instance."""

    def __init__(self):
        self.calls = []
        self.commands = {}
        self.unavailable = False

    def __call__(self, instance):
        clients = self

        class Client:
            def put_command(self, command):
                clients._check()
                clients.calls.append(("put", instance.generation, str(command.pk)))
                return {"status": "accepted"}

            def get_command(self, command_id):
                clients._check()
                clients.calls.append(("get", instance.generation, str(command_id)))
                return clients.commands.get(str(command_id))

            def interrupt(self, command_id):
                clients._check()
                clients.calls.append(
                    ("interrupt", instance.generation, str(command_id))
                )
                return clients.commands.get(str(command_id), {"status": "running"})

            def decide(self, approval):
                clients._check()
                clients.calls.append(("decide", instance.generation, approval.decision))

        return Client()

    def _check(self):
        if self.unavailable:
            raise RuntimeUnavailable("down")

    def of(self, kind):
        return [call for call in self.calls if call[0] == kind]


class RuntimeHarness:
    """Talks to the internal API the way a runtime does."""

    def __init__(self, instance: RuntimeInstance):
        self.instance = instance
        self.client = Client()
        self.seq = 0
        self.token = runtime_token(instance.pk, instance.generation)

    def _call(self, method, path, body=None, token=None):
        with override_settings(ROOT_URLCONF="config.internal_urls"):
            return getattr(self.client, method)(
                f"/internal/v1/runtime-instances/{self.instance.pk}/{path}",
                data=json.dumps(body or {}),
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {token or self.token}",
            )

    def heartbeat(self, status="ready", **extra):
        return self._call("post", "heartbeat", {"status": status, **extra})

    def session(self, thread_id="thread-1"):
        return self._call("put", "session", {"thread_id": thread_id})

    def events(self, *events, seq_start=None):
        batch = []
        for type_, payload in events:
            self.seq = seq_start if seq_start is not None else self.seq + 1
            seq_start = None
            batch.append(
                {
                    "source_seq": self.seq,
                    "source_event_id": f"{self.instance.pk}-{self.seq}",
                    "type": type_,
                    "payload": payload,
                }
            )
        return self._call("post", "events", {"events": batch})

    def ready(self, thread_id="thread-1"):
        assert self.session(thread_id).status_code == 200
        assert self.heartbeat().status_code == 200


class ControlTestCase(TestCase):
    def setUp(self):
        self.objects = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.objects, ignore_errors=True)
        override = override_settings(
            AXP_OBJECT_DIR=self.objects,
            AXP_CHECKPOINT_AFTER_TURNS=0,
            AXP_INTERNAL_URL="http://cp.internal:8001",
        )
        override.enable()
        self.addCleanup(override.disable)
        object_store.cache_clear()
        self.addCleanup(object_store.cache_clear)
        self.driver = FakeDriver()
        self.clients = FakeClients()
        self.controller = Controller(self.driver, client=self.clients)
        self.chat = ChatClient()
        self.agent = self.chat.create_agent()

    def instance(self) -> RuntimeInstance:
        return RuntimeInstance.objects.get(
            agent_id=self.agent["id"], ended_at__isnull=True
        )

    def start_runtime(self, thread_id="thread-1") -> RuntimeHarness:
        self.controller.tick()
        runtime = RuntimeHarness(self.instance())
        runtime.ready(thread_id)
        return runtime

    def reply(self, reply_id):
        return Message.objects.get(pk=reply_id)

    def command_for(self, reply_id) -> AgentCommand:
        return self.reply(reply_id).command


class ProvisioningTests(ControlTestCase):
    def test_message_provisions_runtime_with_snapshot(self):
        sent = self.chat.send(self.agent["id"])
        self.controller.tick()
        instance = self.instance()
        self.assertEqual(instance.generation, 1)
        self.assertEqual(instance.status, "provisioning")
        spec = self.driver.started[0]
        self.assertEqual(spec.env["AXP_RUNTIME_TOKEN"], runtime_token(instance.pk, 1))
        self.assertEqual(spec.env["AXP_CONTROL_PLANE_URL"], "http://cp.internal:8001")
        snapshot = json.loads(spec.env["AXP_MCP_SNAPSHOT"])
        self.assertEqual([m["module_key"] for m in snapshot], ["tasks"])
        self.assertIn(f"axp-state-{self.agent['id']}", self.driver.volumes)
        # Starting a runtime is invisible to the product: the reply is queued.
        self.assertEqual(self.reply(sent["reply"]["id"]).status, "queued")
        self.assertEqual(
            self.chat.get("/chat").json()["agents"][0]["status"], "working"
        )
        # No second runtime while one is live.
        self.controller.tick()
        self.assertEqual(len(self.driver.started), 1)

    def test_start_failure_fails_waiting_replies(self):
        self.driver.fail_start = True
        sent = self.chat.send(self.agent["id"])
        self.controller.tick()
        reply = self.reply(sent["reply"]["id"])
        self.assertEqual(reply.status, "failed")
        self.assertEqual(reply.failure["code"], "AGENT_UNAVAILABLE")
        self.assertEqual(
            self.chat.get("/chat").json()["agents"][0]["status"], "unavailable"
        )

    @override_settings(AXP_DISPATCH_TIMEOUT=0)
    def test_dispatch_timeout_without_ready_runtime(self):
        sent = self.chat.send(self.agent["id"])
        self.controller.tick()  # provisions; never becomes ready
        self.controller.fail_stale_queued()
        self.assertEqual(
            self.reply(sent["reply"]["id"]).failure["code"], "DISPATCH_TIMEOUT"
        )


class InternalApiTests(ControlTestCase):
    def setUp(self):
        super().setUp()
        self.chat.send(self.agent["id"])
        self.controller.tick()
        self.runtime = RuntimeHarness(self.instance())

    def test_public_server_does_not_route_internal_api(self):
        response = Client().post(
            f"/internal/v1/runtime-instances/{self.runtime.instance.pk}/heartbeat"
        )
        self.assertEqual(response.status_code, 404)

    def test_token_is_bound_to_instance_and_generation(self):
        self.assertEqual(self.runtime.heartbeat().status_code, 200)
        bad = self.runtime._call("post", "heartbeat", {"status": "ready"}, token="x")
        self.assertEqual(bad.status_code, 403)
        Agent.objects.filter(pk=self.agent["id"]).update(generation=2)
        stale = self.runtime.heartbeat()
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["error"]["code"], "STALE_GENERATION")

    def test_session_thread_cannot_change(self):
        self.assertEqual(self.runtime.session("t1").status_code, 200)
        self.assertEqual(self.runtime.session("t1").status_code, 200)
        conflict = self.runtime.session("t2")
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(AgentSession.objects.get().thread_id, "t1")

    def test_heartbeat_marks_ready_and_extends_lease(self):
        before = self.runtime.instance.lease_expires_at
        self.runtime.ready()
        instance = self.instance()
        self.assertEqual(instance.status, "ready")
        self.assertNotEqual(instance.lease_expires_at, before)
        self.assertEqual(Agent.objects.get().status, "ready")

    def test_event_ordering(self):
        self.runtime.ready()
        ok = self.runtime.events(
            ("mcp.status", {"module_key": "tasks", "status": "ready"})
        )
        self.assertEqual(ok.json(), {"acked_source_seq": 1})
        gap = self.runtime.events(("mcp.status", {}), seq_start=5)
        self.assertEqual(gap.status_code, 409)
        self.assertEqual(gap.json()["next_expected_source_seq"], 2)
        # Re-sending an acked event is harmless; changing it is a conflict.
        self.runtime.seq = 0
        again = self.runtime.events(
            ("mcp.status", {"module_key": "tasks", "status": "ready"})
        )
        self.assertEqual(again.json(), {"acked_source_seq": 1})
        self.runtime.seq = 0
        conflict = self.runtime.events(("mcp.status", {"module_key": "x"}))
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(self.instance().mcp_status, {"tasks": "ready"})


class ExecutionTests(ControlTestCase):
    def setUp(self):
        super().setUp()
        self.sent = self.chat.send(self.agent["id"], "检查项目结构")
        self.runtime = self.start_runtime()
        self.controller.tick()
        self.command = self.command_for(self.sent["reply"]["id"])

    def test_dispatch_stream_and_complete(self):
        self.assertEqual(self.command.status, "dispatching")
        self.assertEqual(self.clients.of("put"), [("put", 1, str(self.command.pk))])
        command_id = str(self.command.pk)
        self.runtime.events(
            ("turn.started", {"command_id": command_id, "turn_id": "turn-1"}),
            (
                "item.updated",
                {
                    "command_id": command_id,
                    "item": {"id": "c1", "kind": "command", "status": "running"},
                },
            ),
            (
                "item.updated",
                {
                    "command_id": command_id,
                    "item": {
                        "id": "m1",
                        "kind": "agent_message",
                        "status": "running",
                        "text": "正在",
                    },
                },
            ),
        )
        reply = self.reply(self.sent["reply"]["id"])
        self.assertEqual(reply.status, "responding")
        self.assertEqual(
            [(b["type"], b.get("label") or b.get("text")) for b in reply.content],
            [("activity", "运行命令"), ("text", "正在")],
        )
        self.runtime.events(
            (
                "item.updated",
                {
                    "command_id": command_id,
                    "item": {
                        "id": "m1",
                        "kind": "agent_message",
                        "status": "completed",
                        "text": "正在检查。",
                    },
                },
            ),
            (
                "turn.completed",
                {"command_id": command_id, "turn_id": "turn-1", "status": "completed"},
            ),
        )
        reply.refresh_from_db()
        self.assertEqual(reply.status, "completed")
        self.assertEqual(reply.content[0]["status"], "completed")
        self.assertEqual(reply.content[1]["text"], "正在检查。")
        self.command.refresh_from_db()
        self.assertEqual(self.command.status, "succeeded")
        self.assertEqual(self.command.codex_turn_id, "turn-1")
        snapshot = self.chat.get("/chat").json()
        self.assertEqual(snapshot["agents"][0]["status"], "idle")
        assert_no_internal_fields(self, snapshot)

    def test_same_agent_runs_one_command_at_a_time(self):
        second = self.chat.send(self.agent["id"], "第二条")
        self.controller.tick()
        self.assertEqual(self.command_for(second["reply"]["id"]).status, "queued")
        self.runtime.events(
            (
                "turn.completed",
                {"command_id": str(self.command.pk), "status": "completed"},
            )
        )
        self.controller.tick()
        self.assertEqual(self.command_for(second["reply"]["id"]).status, "dispatching")

    def test_failed_turn_has_product_reason(self):
        self.runtime.events(
            ("turn.completed", {"command_id": str(self.command.pk), "status": "failed"})
        )
        reply = self.reply(self.sent["reply"]["id"])
        self.assertEqual(reply.status, "failed")
        self.assertEqual(
            reply.failure,
            {"code": "TURN_FAILED", "message": "智能体执行失败，请稍后再试。"},
        )

    def test_outcome_unknown_is_not_replayed(self):
        self.runtime.events(
            ("command.outcome_unknown", {"command_id": str(self.command.pk)})
        )
        reply = self.reply(self.sent["reply"]["id"])
        self.assertEqual(reply.failure["code"], "REPLY_INTERRUPTED")
        self.controller.tick()
        self.assertEqual(len(self.clients.of("put")), 1)

    def test_stop_sends_interrupt_and_runtime_confirms(self):
        command_id = str(self.command.pk)
        self.runtime.events(
            ("turn.started", {"command_id": command_id, "turn_id": "t"})
        )
        reply_id = self.sent["reply"]["id"]
        self.assertEqual(
            self.chat.post(f"/chat/messages/{reply_id}/stop").json()["status"],
            "stopping",
        )
        self.controller.tick()
        self.controller.tick()
        self.assertEqual(self.clients.of("interrupt"), [("interrupt", 1, command_id)])
        self.runtime.events(
            ("turn.completed", {"command_id": command_id, "status": "interrupted"})
        )
        self.assertEqual(self.reply(reply_id).status, "stopped")

    def test_stop_before_runtime_accepts_cancels_locally(self):
        self.clients.commands[str(self.command.pk)] = None
        reply_id = self.sent["reply"]["id"]
        self.chat.post(f"/chat/messages/{reply_id}/stop")
        self.controller.deliver_interrupts()
        self.assertEqual(self.reply(reply_id).status, "stopped")
        self.command.refresh_from_db()
        self.assertEqual(self.command.status, "cancelled")

    def test_approval_round_trip(self):
        command_id = str(self.command.pk)
        self.runtime.events(
            ("turn.started", {"command_id": command_id, "turn_id": "t"}),
            (
                "approval.requested",
                {
                    "approval_id": "sdk-1",
                    "command_id": command_id,
                    "kind": "command",
                    "summary": {"command": "rm -rf build", "reason": "清理构建产物"},
                },
            ),
        )
        snapshot = self.chat.get("/chat").json()
        [interaction] = snapshot["interactions"]
        self.assertIn("rm -rf build", interaction["prompt"])
        self.assertEqual(snapshot["agents"][0]["status"], "waiting_for_input")
        assert_no_internal_fields(self, interaction)
        answer = self.chat.post(
            f"/chat/interactions/{interaction['id']}/answer", {"value": "allow"}
        )
        self.assertEqual(answer.json()["status"], "submitted")
        self.assertEqual(Approval.objects.get().status, "decided")
        self.controller.tick()
        self.assertEqual(self.clients.of("decide"), [("decide", 1, "accept")])
        self.runtime.events(
            ("approval.applied", {"approval_id": "sdk-1", "decision": "accept"})
        )
        self.assertEqual(Interaction.objects.get().status, "resolved")
        self.assertEqual(Approval.objects.get().status, "applied")
        self.assertEqual(self.reply(self.sent["reply"]["id"]).status, "responding")


class RecoveryTests(ControlTestCase):
    def setUp(self):
        super().setUp()
        self.sent = self.chat.send(self.agent["id"])
        self.runtime = self.start_runtime()
        self.controller.tick()
        self.command = self.command_for(self.sent["reply"]["id"])
        self.runtime.events(
            ("turn.started", {"command_id": str(self.command.pk), "turn_id": "t"})
        )

    def expire(self):
        RuntimeInstance.objects.filter(ended_at__isnull=True).update(
            lease_expires_at=timezone.now() - timedelta(seconds=1)
        )

    def test_lost_runtime_is_fenced_then_replaced(self):
        old = self.instance()
        self.expire()
        self.controller.tick()
        self.assertIn(old.container_id, self.driver.stopped)
        old.refresh_from_db()
        self.assertIsNotNone(old.ended_at)
        self.command.refresh_from_db()
        self.assertEqual(self.command.status, "outcome_unknown")
        # Replacement uses a new generation and the known thread.
        new = self.instance()
        self.assertEqual(new.generation, 2)
        self.assertEqual(self.driver.started[-1].env["AXP_THREAD_ID"], "thread-1")
        # The old runtime is rejected from now on.
        self.assertEqual(self.runtime.heartbeat().status_code, 409)

    def test_reconcile_uses_new_runtime_ledger(self):
        self.expire()
        self.controller.tick()
        RuntimeHarness(self.instance()).ready()
        self.clients.commands[str(self.command.pk)] = {"status": "succeeded"}
        self.controller.tick()
        self.command.refresh_from_db()
        self.assertEqual(self.command.status, "succeeded")
        self.assertEqual(self.reply(self.sent["reply"]["id"]).status, "completed")

    def test_unknown_to_shared_ledger_is_requeued(self):
        self.expire()
        self.controller.tick()
        RuntimeHarness(self.instance()).ready()
        self.clients.commands[str(self.command.pk)] = None
        self.controller.reconcile_unknown()
        self.command.refresh_from_db()
        self.assertEqual(self.command.status, "queued")

    def test_runtime_failure_marks_agent_unavailable(self):
        queued = self.chat.send(self.agent["id"], "排队中")
        self.runtime.heartbeat("error", error_code="MCP_REQUIRED_FAILED")
        reply = self.reply(queued["reply"]["id"])
        self.assertEqual(reply.failure["code"], "AGENT_EXTENSION_FAILED")
        self.assertEqual(
            self.chat.get("/chat").json()["agents"][0]["status"], "unavailable"
        )
        # A new message retries with a fresh runtime.
        self.chat.send(self.agent["id"], "再试一次")
        self.controller.tick()
        self.assertEqual(self.instance().generation, 2)

    def test_recovery_failed_never_replaces_thread(self):
        self.runtime.heartbeat("recovery_failed", error_code="RECOVERY_RESUME_FAILED")
        self.assertEqual(Agent.objects.get().status, "recovery_failed")
        self.assertEqual(AgentSession.objects.get().status, "recovery_failed")
        self.assertEqual(AgentSession.objects.get().thread_id, "thread-1")


class CheckpointTests(ControlTestCase):
    def setUp(self):
        super().setUp()
        override = override_settings(AXP_CHECKPOINT_AFTER_TURNS=1)
        override.enable()
        self.addCleanup(override.disable)
        self.sent = self.chat.send(self.agent["id"])
        self.runtime = self.start_runtime()
        self.controller.tick()
        command = self.command_for(self.sent["reply"]["id"])
        self.runtime.events(
            ("turn.completed", {"command_id": str(command.pk), "status": "completed"})
        )

    def upload(self, checkpoint, data: bytes):
        with override_settings(ROOT_URLCONF="config.internal_urls"):
            return Client().put(
                f"/internal/v1/checkpoints/{checkpoint.pk}/object",
                data=data,
                content_type="application/gzip",
                HTTP_AUTHORIZATION=f"Bearer {self.runtime.token}",
            )

    def test_checkpoint_is_scheduled_uploaded_and_verified(self):
        self.controller.tick()
        checkpoint = AgentCheckpoint.objects.get()
        command = checkpoint.command
        self.assertEqual(command.kind, "checkpoint")
        self.controller.tick()
        command.refresh_from_db()
        self.assertEqual(command.status, "dispatching")
        self.assertTrue(
            command.input["upload"]["url"].endswith(f"/{checkpoint.pk}/object")
        )
        # Normal turns wait behind the checkpoint.
        later = self.chat.send(self.agent["id"], "之后")
        self.controller.tick()
        self.assertEqual(self.command_for(later["reply"]["id"]).status, "queued")

        data = b"checkpoint-bytes"
        self.assertEqual(self.upload(checkpoint, data).status_code, 204)
        self.runtime.events(
            ("checkpoint.started", {"checkpoint_id": str(checkpoint.pk)}),
            (
                "checkpoint.completed",
                {
                    "checkpoint_id": str(checkpoint.pk),
                    "checksum": hashlib.sha256(data).hexdigest(),
                    "size": len(data),
                    "manifest": {"thread_id": "thread-1", "sdk_version": "0.160.1"},
                },
            ),
        )
        checkpoint.refresh_from_db()
        self.assertEqual(checkpoint.status, "available")
        self.assertEqual(checkpoint.sdk_version, "0.160.1")
        # Uploads are closed once the checkpoint is final.
        self.assertEqual(self.upload(checkpoint, b"x").status_code, 409)
        self.controller.tick()
        self.assertEqual(self.command_for(later["reply"]["id"]).status, "dispatching")

    def test_unverified_checkpoint_is_not_available(self):
        self.controller.tick()
        checkpoint = AgentCheckpoint.objects.get()
        self.upload(checkpoint, b"data")
        self.runtime.events(
            (
                "checkpoint.completed",
                {"checkpoint_id": str(checkpoint.pk), "checksum": "0" * 64},
            )
        )
        checkpoint.refresh_from_db()
        self.assertEqual(checkpoint.status, "failed")

    def test_lost_state_restores_from_latest_checkpoint(self):
        self.controller.tick()
        checkpoint = AgentCheckpoint.objects.get()
        data = b"state"
        self.upload(checkpoint, data)
        self.runtime.events(
            (
                "checkpoint.completed",
                {
                    "checkpoint_id": str(checkpoint.pk),
                    "checksum": hashlib.sha256(data).hexdigest(),
                },
            )
        )
        # A turn after the checkpoint, then the host and its volume are lost.
        after = self.chat.send(self.agent["id"], "检查点之后")
        self.controller.tick()
        self.runtime.events(
            (
                "turn.completed",
                {
                    "command_id": str(self.command_for(after["reply"]["id"]).pk),
                    "status": "completed",
                },
            )
        )
        self.driver.volumes.clear()
        RuntimeInstance.objects.filter(ended_at__isnull=True).update(
            lease_expires_at=timezone.now() - timedelta(seconds=1)
        )
        self.chat.send(self.agent["id"], "恢复后")
        self.controller.tick()
        spec = self.driver.started[-1]
        restore = json.loads(spec.env["AXP_RESTORE"])
        self.assertEqual(restore["checkpoint_id"], str(checkpoint.pk))
        self.assertEqual(restore["checksum"], hashlib.sha256(data).hexdigest())
        gap = AgentSession.objects.get().recovery_gap
        self.assertEqual(
            gap["commands"], [str(self.command_for(after["reply"]["id"]).pk)]
        )
        # The restored runtime can download it.
        new = RuntimeHarness(self.instance())
        with override_settings(ROOT_URLCONF="config.internal_urls"):
            download = Client().get(
                f"/internal/v1/checkpoints/{checkpoint.pk}/object",
                HTTP_AUTHORIZATION=f"Bearer {new.token}",
            )
        self.assertEqual(b"".join(download.streaming_content), data)


class IdleTests(ControlTestCase):
    @override_settings(AXP_RUNTIME_IDLE_SECONDS=0)
    def test_idle_runtime_is_stopped(self):
        sent = self.chat.send(self.agent["id"])
        runtime = self.start_runtime()
        self.controller.tick()
        command = self.command_for(sent["reply"]["id"])
        runtime.events(
            ("turn.completed", {"command_id": str(command.pk), "status": "completed"})
        )
        Agent.objects.update(last_active_at=timezone.now() - timedelta(seconds=5))
        container = self.instance().container_id
        self.controller.stop_idle()
        self.assertIn(container, self.driver.stopped)
        self.assertFalse(RuntimeInstance.objects.filter(ended_at__isnull=True).exists())
        self.assertEqual(self.chat.get("/chat").json()["agents"][0]["status"], "idle")


class DeletionTests(ControlTestCase):
    def test_deleted_agent_is_interrupted_then_stopped(self):
        sent = self.chat.send(self.agent["id"])
        runtime = self.start_runtime()
        self.controller.tick()
        command = self.command_for(sent["reply"]["id"])
        runtime.events(
            ("turn.started", {"command_id": str(command.pk), "turn_id": "t"})
        )
        container = self.instance().container_id
        self.assertEqual(
            self.chat.delete(f"/agents/{self.agent['id']}").status_code, 204
        )
        self.controller.tick()
        # Still running: interrupted first, not killed mid-turn.
        self.assertEqual(
            self.clients.of("interrupt"), [("interrupt", 1, str(command.pk))]
        )
        self.assertNotIn(container, self.driver.stopped)
        runtime.events(
            ("turn.completed", {"command_id": str(command.pk), "status": "interrupted"})
        )
        self.controller.tick()
        self.assertIn(container, self.driver.stopped)
        self.assertFalse(RuntimeInstance.objects.filter(ended_at__isnull=True).exists())
        # Nothing restarts it.
        self.controller.tick()
        self.assertEqual(len(self.driver.started), 1)


class ConfigChangeTests(ControlTestCase):
    def test_instructions_are_passed_and_applied_between_turns(self):
        self.chat.patch(f"/agents/{self.agent['id']}", {"description": "第一版指令"})
        sent = self.chat.send(self.agent["id"])
        runtime = self.start_runtime()
        settings = json.loads(self.driver.started[0].env["AXP_CODEX_SETTINGS"])
        self.assertEqual(settings["developer_instructions"], "第一版指令")
        self.controller.tick()
        command = self.command_for(sent["reply"]["id"])
        runtime.events(
            ("turn.started", {"command_id": str(command.pk), "turn_id": "t"})
        )
        old = self.instance()

        self.chat.patch(f"/agents/{self.agent['id']}", {"description": "第二版指令"})
        self.controller.tick()
        # A turn is running: the runtime keeps going until it settles.
        self.assertNotIn(old.container_id, self.driver.stopped)
        runtime.events(
            ("turn.completed", {"command_id": str(command.pk), "status": "completed"})
        )
        self.controller.tick()
        self.assertIn(old.container_id, self.driver.stopped)
        old.refresh_from_db()
        self.assertEqual(old.end_reason, "CONFIG_CHANGED")
        # The next message starts a runtime with the new instructions.
        self.chat.send(self.agent["id"], "新指令下")
        self.controller.tick()
        settings = json.loads(self.driver.started[-1].env["AXP_CODEX_SETTINGS"])
        self.assertEqual(settings["developer_instructions"], "第二版指令")
        self.assertEqual(self.driver.started[-1].env["AXP_THREAD_ID"], "thread-1")

    @override_settings(
        AXP_LLM_RUNTIME_BASE_URL="http://llm-gateway:8317/v1",
        AXP_LLM_API_KEY="runtime-key",
        AXP_RUNTIME_ENV_PASSTHROUGH=["OPENAI_API_KEY"],
        AXP_CODEX_AUTH_FILE="/host/auth.json",
    )
    def test_gateway_mode_keeps_provider_credentials_out(self):
        self.chat.send(self.agent["id"])
        with mock.patch.dict("os.environ", {"OPENAI_API_KEY": "sk-real"}):
            self.start_runtime()
        spec = self.driver.started[0]
        self.assertEqual(spec.env["AXP_LLM_BASE_URL"], "http://llm-gateway:8317/v1")
        self.assertEqual(spec.env["AXP_LLM_API_KEY"], "runtime-key")
        self.assertNotIn("OPENAI_API_KEY", spec.env)
        self.assertNotIn("AXP_CODEX_AUTH_FILE", spec.env)


class McpTests(TestCase):
    def setUp(self):
        self.agent_data = ChatClient().create_agent()
        self.agent = Agent.objects.get(pk=self.agent_data["id"])

    def test_builtin_tasks_module_bound_by_default(self):
        binding = self.agent.mcp_bindings.get()
        self.assertEqual(binding.module_key, "tasks")
        self.assertEqual(self.agent.config_version, 1)

    def test_config_is_validated_against_schema(self):
        revision = McpModuleRevision.objects.get(module_key="tasks")
        with self.assertRaises(mcp.McpConfigError):
            mcp.bind(self.agent, revision, config={"max_tasks": "many"})
        with self.assertRaises(mcp.McpConfigError):
            mcp.bind(self.agent, revision, secret_ref="plain-secret")
        mcp.bind(self.agent, revision, config={"max_tasks": 5}, required=True)
        [module] = mcp.snapshot(self.agent)
        self.assertEqual(module["config"], {"max_tasks": 5})
        self.assertTrue(module["required"])

    def test_launch_spec_rules_and_immutability(self):
        with self.assertRaises(mcp.McpConfigError):
            mcp.register_revision("x", "1", {"command": "sh", "cwd": "/host"}, {})
        mcp.register_revision("x", "1", {"command": "x-server"}, {})
        mcp.register_revision("x", "1", {"command": "x-server"}, {})
        with self.assertRaises(mcp.McpConfigError):
            mcp.register_revision("x", "1", {"command": "other"}, {})

    def test_management_commands(self):
        spec = Path(tempfile.mkdtemp()) / "spec.json"
        spec.write_text(
            json.dumps(
                {
                    "module_key": "notes",
                    "revision": "2",
                    "launch_spec": {"command": "notes-mcp"},
                    "config_schema": {"type": "object"},
                }
            )
        )
        call_command("mcp_register", str(spec))
        call_command("mcp_bind", str(self.agent.pk), "notes", "--tools", "read,write")
        binding = self.agent.mcp_bindings.get(module_key="notes")
        self.assertEqual(binding.allowed_tools, ["read", "write"])
        with self.assertRaises(CommandError):
            call_command("mcp_bind", str(self.agent.pk), "missing")
