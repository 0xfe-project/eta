import hashlib
import json
import uuid
from contextlib import closing
from datetime import timedelta
from unittest import mock

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import Client, override_settings
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

from .helpers import assert_no_internal_fields, error_of

pytestmark = pytest.mark.django_db


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
                clients._record("put", instance, str(command.pk))
                return {"status": "accepted"}

            def get_command(self, command_id):
                clients._record("get", instance, str(command_id))
                return clients.commands.get(str(command_id))

            def interrupt(self, command_id):
                clients._record("interrupt", instance, str(command_id))
                return clients.commands.get(str(command_id), {"status": "running"})

            def decide(self, approval):
                clients._record("decide", instance, approval.decision)

        return Client()

    def _record(self, kind, instance, arg):
        if self.unavailable:
            raise RuntimeUnavailable("down")
        self.calls.append((kind, instance.generation, arg))

    def of(self, kind):
        return [call for call in self.calls if call[0] == kind]


def internal(method, path, token, **kwargs):
    with override_settings(ROOT_URLCONF="config.internal_urls"):
        return getattr(Client(), method)(
            f"/internal/v1/{path}", HTTP_AUTHORIZATION=f"Bearer {token}", **kwargs
        )


class RuntimeHarness:
    """Talks to the internal API the way a runtime does."""

    def __init__(self, instance: RuntimeInstance):
        self.instance = instance
        self.seq = 0
        self.token = runtime_token(instance.pk, instance.generation)

    def call(self, method, path, body=None, token=None):
        return internal(
            method,
            f"runtime-instances/{self.instance.pk}/{path}",
            token or self.token,
            data=json.dumps(body or {}),
            content_type="application/json",
        )

    def heartbeat(self, status="ready", **extra):
        return self.call("post", "heartbeat", {"status": status, **extra})

    def session(self, thread_id="thread-1"):
        return self.call("put", "session", {"thread_id": thread_id})

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
        return self.call("post", "events", {"events": batch})

    def turn_started(self, command, turn_id="t"):
        payload = {"command_id": str(command.pk), "turn_id": turn_id}
        return self.events(("turn.started", payload))

    def turn_completed(self, command, status="completed"):
        payload = {"command_id": str(command.pk), "status": status}
        return self.events(("turn.completed", payload))

    def ready(self, thread_id="thread-1"):
        assert self.session(thread_id).status_code == 200
        assert self.heartbeat().status_code == 200


class Control:
    """A controller with fake Docker and runtime clients, plus one agent."""

    def __init__(self, chat):
        self.driver = FakeDriver()
        self.clients = FakeClients()
        self.controller = Controller(self.driver, client=self.clients)
        self.chat = chat
        self.agent = chat.create_agent()
        self.tick = self.controller.tick

    def send(self, text="检查项目结构"):
        return self.chat.send(self.agent["id"], text)

    def instance(self) -> RuntimeInstance:
        return RuntimeInstance.objects.get(
            agent_id=self.agent["id"], ended_at__isnull=True
        )

    def start_runtime(self, thread_id="thread-1") -> RuntimeHarness:
        self.tick()
        runtime = RuntimeHarness(self.instance())
        runtime.ready(thread_id)
        return runtime

    def reply(self, sent) -> Message:
        return Message.objects.get(pk=sent["reply"]["id"])

    def command(self, sent) -> AgentCommand:
        return self.reply(sent).command

    def agent_status(self):
        return self.chat.get("/chat").json()["agents"][0]["status"]

    def expire_leases(self):
        RuntimeInstance.objects.filter(ended_at__isnull=True).update(
            lease_expires_at=timezone.now() - timedelta(seconds=1)
        )


@pytest.fixture
def ctl(chat, settings, tmp_path):
    settings.AXP_OBJECT_DIR = tmp_path
    settings.AXP_CHECKPOINT_AFTER_TURNS = 0
    settings.AXP_INTERNAL_URL = "http://cp.internal:8001"
    object_store.cache_clear()
    yield Control(chat)
    object_store.cache_clear()


@pytest.fixture
def running(ctl):
    """One message dispatched to a ready runtime: (sent, runtime, command)."""
    sent = ctl.send()
    runtime = ctl.start_runtime()
    ctl.tick()
    return sent, runtime, ctl.command(sent)


class TestProvisioning:
    def test_message_provisions_runtime_with_snapshot(self, ctl):
        sent = ctl.send()
        ctl.tick()
        instance = ctl.instance()
        assert (instance.generation, instance.status) == (1, "provisioning")
        env = ctl.driver.started[0].env
        assert env["AXP_RUNTIME_TOKEN"] == runtime_token(instance.pk, 1)
        assert env["AXP_CONTROL_PLANE_URL"] == "http://cp.internal:8001"
        snapshot = json.loads(env["AXP_MCP_SNAPSHOT"])
        assert [m["module_key"] for m in snapshot] == ["tasks"]
        assert f"axp-state-{ctl.agent['id']}" in ctl.driver.volumes
        # Starting a runtime is invisible to the product: the reply is queued.
        assert ctl.reply(sent).status == "queued"
        assert ctl.agent_status() == "working"
        # No second runtime while one is live.
        ctl.tick()
        assert len(ctl.driver.started) == 1

    def test_start_failure_fails_waiting_replies(self, ctl):
        ctl.driver.fail_start = True
        sent = ctl.send()
        ctl.tick()
        reply = ctl.reply(sent)
        assert reply.status == "failed"
        assert reply.failure["code"] == "AGENT_UNAVAILABLE"
        assert ctl.agent_status() == "unavailable"

    def test_dispatch_timeout_without_ready_runtime(self, ctl, settings):
        settings.AXP_DISPATCH_TIMEOUT = 0
        sent = ctl.send()
        ctl.tick()  # provisions; never becomes ready
        ctl.controller.fail_stale_queued()
        assert ctl.reply(sent).failure["code"] == "DISPATCH_TIMEOUT"


class TestInternalApi:
    @pytest.fixture
    def runtime(self, ctl):
        ctl.send()
        ctl.tick()
        return RuntimeHarness(ctl.instance())

    def test_public_server_does_not_route_internal_api(self, runtime):
        path = f"/internal/v1/runtime-instances/{runtime.instance.pk}/heartbeat"
        assert Client().post(path).status_code == 404

    def test_token_is_bound_to_instance_and_generation(self, ctl, runtime):
        assert runtime.heartbeat().status_code == 200
        bad = runtime.call("post", "heartbeat", {"status": "ready"}, token="x")
        assert bad.status_code == 403
        Agent.objects.filter(pk=ctl.agent["id"]).update(generation=2)
        assert error_of(runtime.heartbeat()) == (409, "STALE_GENERATION")

    def test_session_thread_cannot_change(self, runtime):
        assert runtime.session("t1").status_code == 200
        assert runtime.session("t1").status_code == 200
        assert runtime.session("t2").status_code == 409
        assert AgentSession.objects.get().thread_id == "t1"

    def test_heartbeat_marks_ready_and_extends_lease(self, ctl, runtime):
        before = runtime.instance.lease_expires_at
        runtime.ready()
        instance = ctl.instance()
        assert instance.status == "ready"
        assert instance.lease_expires_at != before
        assert Agent.objects.get().status == "ready"

    def test_event_ordering(self, ctl, runtime):
        runtime.ready()
        status = ("mcp.status", {"module_key": "tasks", "status": "ready"})
        assert runtime.events(status).json() == {"acked_source_seq": 1}
        gap = runtime.events(("mcp.status", {}), seq_start=5)
        assert gap.status_code == 409
        assert gap.json()["next_expected_source_seq"] == 2
        # Re-sending an acked event is harmless; changing it is a conflict.
        runtime.seq = 0
        assert runtime.events(status).json() == {"acked_source_seq": 1}
        runtime.seq = 0
        conflict = runtime.events(("mcp.status", {"module_key": "x"}))
        assert conflict.status_code == 409
        assert ctl.instance().mcp_status == {"tasks": "ready"}


def item(command_id, **fields):
    return ("item.updated", {"command_id": command_id, "item": fields})


class TestExecution:
    def test_dispatch_stream_and_complete(self, ctl, running):
        sent, runtime, command = running
        assert command.status == "dispatching"
        assert ctl.clients.of("put") == [("put", 1, str(command.pk))]
        command_id = str(command.pk)
        runtime.turn_started(command, "turn-1")
        runtime.events(
            item(command_id, id="c1", kind="command", status="running"),
            item(
                command_id, id="m1", kind="agent_message", status="running", text="正在"
            ),
        )
        reply = ctl.reply(sent)
        assert reply.status == "responding"
        assert [
            (b["type"], b.get("label") or b.get("text")) for b in reply.content
        ] == [
            ("activity", "运行命令"),
            ("text", "正在"),
        ]
        runtime.events(
            item(
                command_id,
                id="m1",
                kind="agent_message",
                status="completed",
                text="正在检查。",
            ),
            (
                "turn.completed",
                {"command_id": command_id, "turn_id": "turn-1", "status": "completed"},
            ),
        )
        reply.refresh_from_db()
        assert reply.status == "completed"
        assert reply.content[0]["status"] == "completed"
        assert reply.content[1]["text"] == "正在检查。"
        command.refresh_from_db()
        assert (command.status, command.codex_turn_id) == ("succeeded", "turn-1")
        snapshot = ctl.chat.get("/chat").json()
        assert snapshot["agents"][0]["status"] == "idle"
        assert_no_internal_fields(snapshot)

    def test_same_agent_runs_one_command_at_a_time(self, ctl, running):
        _, runtime, command = running
        second = ctl.send("第二条")
        ctl.tick()
        assert ctl.command(second).status == "queued"
        runtime.turn_completed(command)
        ctl.tick()
        assert ctl.command(second).status == "dispatching"

    def test_failed_turn_has_product_reason(self, ctl, running):
        sent, runtime, command = running
        runtime.turn_completed(command, "failed")
        reply = ctl.reply(sent)
        assert reply.status == "failed"
        assert reply.failure == {
            "code": "TURN_FAILED",
            "message": "智能体执行失败，请稍后再试。",
        }

    def test_outcome_unknown_is_not_replayed(self, ctl, running):
        sent, runtime, command = running
        runtime.events(("command.outcome_unknown", {"command_id": str(command.pk)}))
        assert ctl.reply(sent).failure["code"] == "REPLY_INTERRUPTED"
        ctl.tick()
        assert len(ctl.clients.of("put")) == 1

    def test_stop_sends_interrupt_and_runtime_confirms(self, ctl, running):
        sent, runtime, command = running
        runtime.turn_started(command)
        stop = ctl.chat.post(f"/chat/messages/{sent['reply']['id']}/stop")
        assert stop.json()["status"] == "stopping"
        ctl.tick()
        ctl.tick()
        assert ctl.clients.of("interrupt") == [("interrupt", 1, str(command.pk))]
        runtime.turn_completed(command, "interrupted")
        assert ctl.reply(sent).status == "stopped"

    def test_stop_before_runtime_accepts_cancels_locally(self, ctl, running):
        sent, _, command = running
        ctl.clients.commands[str(command.pk)] = None
        ctl.chat.post(f"/chat/messages/{sent['reply']['id']}/stop")
        ctl.controller.deliver_interrupts()
        assert ctl.reply(sent).status == "stopped"
        command.refresh_from_db()
        assert command.status == "cancelled"

    def test_approval_round_trip(self, ctl, running):
        sent, runtime, command = running
        runtime.turn_started(command)
        summary = {"command": "rm -rf build", "reason": "清理构建产物"}
        runtime.events(
            (
                "approval.requested",
                {
                    "approval_id": "sdk-1",
                    "command_id": str(command.pk),
                    "kind": "command",
                    "summary": summary,
                },
            ),
        )
        snapshot = ctl.chat.get("/chat").json()
        [interaction] = snapshot["interactions"]
        assert "rm -rf build" in interaction["prompt"]
        assert snapshot["agents"][0]["status"] == "waiting_for_input"
        assert_no_internal_fields(interaction)
        answer = ctl.chat.post(
            f"/chat/interactions/{interaction['id']}/answer", {"value": "allow"}
        )
        assert answer.json()["status"] == "submitted"
        assert Approval.objects.get().status == "decided"
        ctl.tick()
        assert ctl.clients.of("decide") == [("decide", 1, "accept")]
        runtime.events(
            ("approval.applied", {"approval_id": "sdk-1", "decision": "accept"})
        )
        assert Interaction.objects.get().status == "resolved"
        assert Approval.objects.get().status == "applied"
        assert ctl.reply(sent).status == "responding"


class TestRecovery:
    @pytest.fixture
    def started(self, running):
        sent, runtime, command = running
        runtime.turn_started(command)
        return running

    def test_lost_runtime_is_fenced_then_replaced(self, ctl, started):
        _, runtime, command = started
        old = ctl.instance()
        ctl.expire_leases()
        ctl.tick()
        assert old.container_id in ctl.driver.stopped
        old.refresh_from_db()
        assert old.ended_at is not None
        command.refresh_from_db()
        assert command.status == "outcome_unknown"
        # Replacement uses a new generation and the known thread.
        assert ctl.instance().generation == 2
        assert ctl.driver.started[-1].env["AXP_THREAD_ID"] == "thread-1"
        # The old runtime is rejected from now on.
        assert runtime.heartbeat().status_code == 409

    def test_reconcile_uses_new_runtime_ledger(self, ctl, started):
        sent, _, command = started
        ctl.expire_leases()
        ctl.tick()
        RuntimeHarness(ctl.instance()).ready()
        ctl.clients.commands[str(command.pk)] = {"status": "succeeded"}
        ctl.tick()
        command.refresh_from_db()
        assert command.status == "succeeded"
        assert ctl.reply(sent).status == "completed"

    def test_unknown_to_shared_ledger_is_requeued(self, ctl, started):
        _, _, command = started
        ctl.expire_leases()
        ctl.tick()
        RuntimeHarness(ctl.instance()).ready()
        ctl.clients.commands[str(command.pk)] = None
        ctl.controller.reconcile_unknown()
        command.refresh_from_db()
        assert command.status == "queued"

    def test_runtime_failure_marks_agent_unavailable(self, ctl, started):
        _, runtime, _ = started
        queued = ctl.send("排队中")
        runtime.heartbeat("error", error_code="MCP_REQUIRED_FAILED")
        assert ctl.reply(queued).failure["code"] == "AGENT_EXTENSION_FAILED"
        assert ctl.agent_status() == "unavailable"
        # A new message retries with a fresh runtime.
        ctl.send("再试一次")
        ctl.tick()
        assert ctl.instance().generation == 2

    def test_recovery_failed_never_replaces_thread(self, started):
        _, runtime, _ = started
        runtime.heartbeat("recovery_failed", error_code="RECOVERY_RESUME_FAILED")
        assert Agent.objects.get().status == "recovery_failed"
        session = AgentSession.objects.get()
        assert (session.status, session.thread_id) == ("recovery_failed", "thread-1")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


class TestCheckpoint:
    @pytest.fixture
    def runtime(self, ctl, settings):
        settings.AXP_CHECKPOINT_AFTER_TURNS = 1
        sent = ctl.send()
        runtime = ctl.start_runtime()
        ctl.tick()
        runtime.turn_completed(ctl.command(sent))
        return runtime

    @pytest.fixture
    def checkpoint(self, ctl, runtime):
        ctl.tick()
        return AgentCheckpoint.objects.get()

    def upload(self, runtime, checkpoint, data: bytes):
        return internal(
            "put",
            f"checkpoints/{checkpoint.pk}/object",
            runtime.token,
            data=data,
            content_type="application/gzip",
        )

    def complete(self, runtime, checkpoint, checksum, **extra):
        payload = {"checkpoint_id": str(checkpoint.pk), "checksum": checksum, **extra}
        runtime.events(("checkpoint.completed", payload))

    def test_checkpoint_is_scheduled_uploaded_and_verified(
        self, ctl, runtime, checkpoint
    ):
        command = checkpoint.command
        assert command.kind == "checkpoint"
        ctl.tick()
        command.refresh_from_db()
        assert command.status == "dispatching"
        assert command.input["upload"]["url"].endswith(f"/{checkpoint.pk}/object")
        # Normal turns wait behind the checkpoint.
        later = ctl.send("之后")
        ctl.tick()
        assert ctl.command(later).status == "queued"

        data = b"checkpoint-bytes"
        assert self.upload(runtime, checkpoint, data).status_code == 204
        runtime.events(("checkpoint.started", {"checkpoint_id": str(checkpoint.pk)}))
        self.complete(
            runtime,
            checkpoint,
            sha256(data),
            size=len(data),
            manifest={"thread_id": "thread-1", "sdk_version": "0.160.1"},
        )
        checkpoint.refresh_from_db()
        assert (checkpoint.status, checkpoint.sdk_version) == ("available", "0.160.1")
        # Uploads are closed once the checkpoint is final.
        assert self.upload(runtime, checkpoint, b"x").status_code == 409
        ctl.tick()
        assert ctl.command(later).status == "dispatching"

    def test_unverified_checkpoint_is_not_available(self, runtime, checkpoint):
        self.upload(runtime, checkpoint, b"data")
        self.complete(runtime, checkpoint, "0" * 64)
        checkpoint.refresh_from_db()
        assert checkpoint.status == "failed"

    def test_lost_state_restores_from_latest_checkpoint(self, ctl, runtime, checkpoint):
        data = b"state"
        self.upload(runtime, checkpoint, data)
        self.complete(runtime, checkpoint, sha256(data))
        # A turn after the checkpoint, then the host and its volume are lost.
        after = ctl.send("检查点之后")
        ctl.tick()
        runtime.turn_completed(ctl.command(after))
        ctl.driver.volumes.clear()
        ctl.expire_leases()
        ctl.send("恢复后")
        ctl.tick()
        restore = json.loads(ctl.driver.started[-1].env["AXP_RESTORE"])
        assert restore["checkpoint_id"] == str(checkpoint.pk)
        assert restore["checksum"] == sha256(data)
        gap = AgentSession.objects.get().recovery_gap
        assert gap["commands"] == [str(ctl.command(after).pk)]
        # The restored runtime can download it.
        new = RuntimeHarness(ctl.instance())
        download = internal("get", f"checkpoints/{checkpoint.pk}/object", new.token)
        # A WSGI server closes the response; the test client leaves it to us.
        with closing(download):
            assert b"".join(download.streaming_content) == data


def test_idle_runtime_is_stopped(ctl, running, settings):
    settings.AXP_RUNTIME_IDLE_SECONDS = 0
    _, runtime, command = running
    runtime.turn_completed(command)
    Agent.objects.update(last_active_at=timezone.now() - timedelta(seconds=5))
    container = ctl.instance().container_id
    ctl.controller.stop_idle()
    assert container in ctl.driver.stopped
    assert not RuntimeInstance.objects.filter(ended_at__isnull=True).exists()
    assert ctl.agent_status() == "idle"


def test_deleted_agent_is_interrupted_then_stopped(ctl, running):
    _, runtime, command = running
    runtime.turn_started(command)
    container = ctl.instance().container_id
    assert ctl.chat.delete(f"/agents/{ctl.agent['id']}").status_code == 204
    ctl.tick()
    # Still running: interrupted first, not killed mid-turn.
    assert ctl.clients.of("interrupt") == [("interrupt", 1, str(command.pk))]
    assert container not in ctl.driver.stopped
    runtime.turn_completed(command, "interrupted")
    ctl.tick()
    assert container in ctl.driver.stopped
    assert not RuntimeInstance.objects.filter(ended_at__isnull=True).exists()
    # Nothing restarts it.
    ctl.tick()
    assert len(ctl.driver.started) == 1


class TestConfigChange:
    def instructions(self, spec):
        return json.loads(spec.env["AXP_CODEX_SETTINGS"])["developer_instructions"]

    def test_instructions_are_passed_and_applied_between_turns(self, ctl):
        agent_path = f"/agents/{ctl.agent['id']}"
        ctl.chat.patch(agent_path, {"description": "第一版指令"})
        sent = ctl.send()
        runtime = ctl.start_runtime()
        assert self.instructions(ctl.driver.started[0]) == "第一版指令"
        ctl.tick()
        command = ctl.command(sent)
        runtime.turn_started(command)
        old = ctl.instance()

        ctl.chat.patch(agent_path, {"description": "第二版指令"})
        ctl.tick()
        # A turn is running: the runtime keeps going until it settles.
        assert old.container_id not in ctl.driver.stopped
        runtime.turn_completed(command)
        ctl.tick()
        assert old.container_id in ctl.driver.stopped
        old.refresh_from_db()
        assert old.end_reason == "CONFIG_CHANGED"
        # The next message starts a runtime with the new instructions.
        ctl.send("新指令下")
        ctl.tick()
        assert self.instructions(ctl.driver.started[-1]) == "第二版指令"
        assert ctl.driver.started[-1].env["AXP_THREAD_ID"] == "thread-1"

    def test_gateway_mode_keeps_provider_credentials_out(self, ctl, settings):
        settings.AXP_LLM_RUNTIME_BASE_URL = "http://llm-gateway:8317/v1"
        settings.AXP_LLM_API_KEY = "runtime-key"
        settings.AXP_RUNTIME_ENV_PASSTHROUGH = ["OPENAI_API_KEY"]
        settings.AXP_CODEX_AUTH_FILE = "/host/auth.json"
        ctl.send()
        with mock.patch.dict("os.environ", {"OPENAI_API_KEY": "sk-real"}):
            ctl.start_runtime()
        env = ctl.driver.started[0].env
        assert env["AXP_LLM_BASE_URL"] == "http://llm-gateway:8317/v1"
        assert env["AXP_LLM_API_KEY"] == "runtime-key"
        assert "OPENAI_API_KEY" not in env
        assert "AXP_CODEX_AUTH_FILE" not in env


class TestMcp:
    @pytest.fixture
    def agent(self, agent):
        return Agent.objects.get(pk=agent["id"])

    def test_builtin_tasks_module_bound_by_default(self, agent):
        assert agent.mcp_bindings.get().module_key == "tasks"
        assert agent.config_version == 1

    def test_config_is_validated_against_schema(self, agent):
        revision = McpModuleRevision.objects.get(module_key="tasks")
        with pytest.raises(mcp.McpConfigError):
            mcp.bind(agent, revision, config={"max_tasks": "many"})
        with pytest.raises(mcp.McpConfigError):
            mcp.bind(agent, revision, secret_ref="plain-secret")
        mcp.bind(agent, revision, config={"max_tasks": 5}, required=True)
        [module] = mcp.snapshot(agent)
        assert module["config"] == {"max_tasks": 5}
        assert module["required"]

    def test_launch_spec_rules_and_immutability(self):
        with pytest.raises(mcp.McpConfigError):
            mcp.register_revision("x", "1", {"command": "sh", "cwd": "/host"}, {})
        mcp.register_revision("x", "1", {"command": "x-server"}, {})
        mcp.register_revision("x", "1", {"command": "x-server"}, {})
        with pytest.raises(mcp.McpConfigError):
            mcp.register_revision("x", "1", {"command": "other"}, {})

    def test_management_commands(self, agent, tmp_path):
        spec = tmp_path / "spec.json"
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
        call_command("mcp_bind", str(agent.pk), "notes", "--tools", "read,write")
        binding = agent.mcp_bindings.get(module_key="notes")
        assert binding.allowed_tools == ["read", "write"]
        with pytest.raises(CommandError):
            call_command("mcp_bind", str(agent.pk), "missing")
