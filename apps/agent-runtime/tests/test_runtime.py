import json
import logging
import os
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import replace
from pathlib import Path

import pytest
from dirty_equals import IsPartialDict

from axp_runtime import runtime as runtime_module
from axp_runtime.config import Settings
from axp_runtime.control_plane import ControlPlaneError
from axp_runtime.runtime import Runtime

FAKE = [sys.executable, "-m", "axp_runtime.testing.fake_app_server"]
PLUGINS = Path(__file__).resolve().parent.parent / "plugins"
# Crash scenarios log expected tracebacks.
logging.disable(logging.CRITICAL)
# The scripted app-server runs from the workspace directory.
os.environ["PYTHONPATH"] = str(Path(__file__).resolve().parent.parent)


SNAPSHOT_URL = "http://objects.invalid/agents/agent-1/snapshot.tar.zst"


class StubControlPlane:
    """Records what the runtime reports; acks every event batch."""

    def __init__(self, thread_conflict=False):
        self.events: list[dict] = []
        self.sessions: list[dict] = []
        self.heartbeats: list[dict] = []
        self.thread_conflict = thread_conflict
        self.lock = threading.Lock()

    def heartbeat(self, body):
        self.heartbeats.append(body)
        return {}

    def register_session(self, body):
        if self.thread_conflict:
            raise ControlPlaneError(409, {"error": {"code": "THREAD_MISMATCH"}})
        self.sessions.append(body)
        return {}

    def post_events(self, events):
        with self.lock:
            self.events.extend(events)
        return {"acked_source_seq": events[-1]["source_seq"]}

    def snapshot_upload_url(self):
        return SNAPSHOT_URL

    def types(self):
        with self.lock:
            return [e["type"] for e in self.events]

    def wait_for(self, type_, timeout=10, **payload):
        """First event of this type whose payload contains these fields."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                found = [
                    e["payload"]
                    for e in self.events
                    if e["type"] == type_ and e["payload"] == IsPartialDict(payload)
                ]
            if found:
                return found[0]
            time.sleep(0.02)
        raise AssertionError(f"{type_} not seen; got {self.types()}")

    def completed(self, command_id):
        return self.wait_for("turn.completed", command_id=command_id)


class FakeQueue:
    """The agent's queue, empty: tests hand commands to the runtime directly."""

    def __init__(self, settings, handle):
        pass

    def start(self):
        pass

    def stop(self):
        pass

    def take(self):
        time.sleep(0.02)
        return None


class Harness:
    """Starts runtimes against stub control planes; shuts them all down.

    Presigned URLs resolve to ``objects``, an in-memory object store.
    """

    def __init__(self, tmp: Path, monkeypatch):
        self.tmp = tmp
        self.objects: dict[str, bytes] = {}
        monkeypatch.setattr(runtime_module, "upload", self._upload)
        monkeypatch.setattr(runtime_module, "download", self._download)
        self.settings = Settings(
            agent_id="agent-1",
            instance_id=str(uuid.uuid4()),
            generation=1,
            token="secret",
            gateway_url="http://gateway.invalid",
            home_dir=tmp / "home",
            known_thread_id=None,
            model=None,
            codex_launch=FAKE,
            heartbeat_seconds=0.05,
            plugins_dir=PLUGINS,
        )
        self.runtimes: list[Runtime] = []

    def start(self, cp=None, **changes) -> tuple[Runtime, StubControlPlane]:
        cp = cp or StubControlPlane()
        runtime = Runtime(replace(self.settings, **changes), cp, queue=FakeQueue)
        self.runtimes.append(runtime)
        runtime.boot()
        return runtime, cp

    def _upload(self, url, path):
        self.objects[url] = Path(path).read_bytes()

    def _download(self, url, path):
        if url not in self.objects:
            raise OSError("404")
        Path(path).write_bytes(self.objects[url])


@pytest.fixture
def rt(tmp_path, monkeypatch):
    harness = Harness(tmp_path, monkeypatch)
    yield harness
    for runtime in harness.runtimes:
        runtime.shutdown()


def send(runtime, text, kind="turn", payload=None, seq=None):
    command_id = str(uuid.uuid4())
    runtime.accept(
        command_id,
        {
            "kind": kind,
            "agent_sequence": seq or int(time.time() * 1000),
            "payload": payload or {"text": text},
        },
    )
    return command_id


class TestLlmGateway:
    def overrides(self, settings):
        return Runtime(settings, StubControlPlane())._codex_config().config_overrides

    def test_codex_uses_gateway_as_model_provider(self, rt):
        settings = replace(rt.settings, model_context_window=256000)
        assert {
            'model_provider="axp"',
            'model_providers.axp.base_url="http://gateway.invalid/v1"',
            'model_providers.axp.wire_api="responses"',
            'model_providers.axp.env_key="AXP_RUNTIME_LLM_KEY"',
            "model_context_window=256000",
        } <= set(self.overrides(settings))

    def test_codex_authenticates_as_the_runtime_instance(self, rt):
        env = Runtime(rt.settings, StubControlPlane())._codex_config().env
        assert env["AXP_RUNTIME_LLM_KEY"] == f"{rt.settings.instance_id}.secret"


class TestTelemetry:
    def overrides(self, settings):
        return Runtime(settings, StubControlPlane())._codex_config().config_overrides

    def test_codex_exports_to_the_runtime_endpoint(self, rt, monkeypatch):
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel-collector:4318/")
        monkeypatch.setenv(
            "OTEL_RESOURCE_ATTRIBUTES",
            "deployment.environment.name=production,axp.agent.id=a1",
        )
        overrides = set(self.overrides(rt.settings))
        assert {
            'otel.environment="production"',
            "otel.log_user_prompt=true",
            'otel.exporter={"otlp-http" = {"endpoint" = '
            '"http://otel-collector:4318/v1/logs", "protocol" = "binary"}}',
            'otel.trace_exporter={"otlp-http" = {"endpoint" = '
            '"http://otel-collector:4318/v1/traces", "protocol" = "binary"}}',
        } <= overrides


class TestBoot:
    def test_first_boot_creates_and_registers_thread(self, rt):
        runtime, cp = rt.start()
        assert runtime.status == "ready"
        assert cp.sessions[0] == IsPartialDict(
            thread_id=runtime.thread_id, resumed=False
        )

    def test_restart_resumes_same_thread(self, rt):
        first, _ = rt.start()
        first.shutdown()
        second, cp = rt.start(
            known_thread_id=first.thread_id, instance_id="i2", generation=2
        )
        assert second.status == "ready"
        assert second.thread_id == first.thread_id
        assert cp.sessions[0]["resumed"]

    def test_instructions_reach_codex_on_start_and_resume(self, rt):
        store = rt.settings.codex_home / "fake_threads.json"

        def instructions(runtime):
            return json.loads(store.read_text())[runtime.thread_id]["instructions"]

        first, _ = rt.start(developer_instructions="你是代码审查员。")
        assert instructions(first) == "你是代码审查员。"
        first.shutdown()
        second, _ = rt.start(
            developer_instructions="只用中文回答。",
            known_thread_id=first.thread_id,
            instance_id="i2",
            generation=2,
        )
        assert instructions(second) == "只用中文回答。"

    def test_lost_state_never_creates_replacement_thread(self, rt):
        runtime, cp = rt.start(known_thread_id="thread-from-control-plane")
        assert (runtime.status, runtime.error_code) == (
            "recovery_failed",
            "RECOVERY_RESUME_FAILED",
        )
        assert cp.sessions == []

    def test_control_plane_thread_conflict(self, rt):
        runtime, _ = rt.start(cp=StubControlPlane(thread_conflict=True))
        assert runtime.error_code == "RECOVERY_THREAD_MISMATCH"

    def test_installs_the_image_plugins(self, rt):
        runtime, _ = rt.start()
        assert runtime.status == "ready"
        [installed] = (
            runtime.settings.codex_home / "plugins/cache/axp/tasks"
        ).iterdir()
        # MCP configs get this instance's values; Codex expands none itself.
        server = json.loads((installed / ".mcp.json").read_text())["mcpServers"]
        assert server["tasks"]["env"] == {
            "AXP_WORKSPACE_DIR": str(runtime.settings.workspace_dir)
        }
        [memory] = (runtime.settings.codex_home / "plugins/cache/axp/memory").iterdir()
        server = json.loads((memory / ".mcp.json").read_text())["mcpServers"]
        assert server["memory"]["url"] == "http://gateway.invalid/memory/mcp"
        config = (runtime.settings.codex_home / "config.toml").read_text()
        assert '[plugins."tasks@axp"]' in config
        assert '[plugins."memory@axp"]' in config

    def test_broken_plugin_fails_startup(self, rt, tmp_path):
        plugins = tmp_path / "plugins"
        catalog = plugins / ".agents" / "plugins"
        catalog.mkdir(parents=True)
        (catalog / "marketplace.json").write_text(
            json.dumps(
                {
                    "name": "axp",
                    "plugins": [
                        {
                            "name": "missing",
                            "source": {"source": "local", "path": "./missing"},
                            "policy": {"installation": "AVAILABLE"},
                            "category": "Productivity",
                        }
                    ],
                }
            )
        )
        runtime, _ = rt.start(plugins_dir=plugins)
        assert (runtime.status, runtime.error_code) == (
            "error",
            "PLUGIN_INSTALL_FAILED",
        )


def reply_text(cp, command_id):
    return [
        e["payload"]["item"]["text"]
        for e in cp.events
        if e["type"] == "item.updated" and e["payload"]["command_id"] == command_id
    ][-1]


class TestTurns:
    def test_turn_streams_items_and_completes(self, rt):
        runtime, cp = rt.start()
        command_id = send(runtime, "你好")
        assert cp.completed(command_id)["status"] == "completed"
        items = [
            e["payload"]["item"]
            for e in cp.events
            if e["type"] == "item.updated" and e["payload"]["command_id"] == command_id
        ]
        assert items[-1] == IsPartialDict(
            kind="agent_message", status="completed", text="收到：你好"
        )
        seqs = [e["source_seq"] for e in cp.events]
        assert seqs == list(range(1, len(seqs) + 1))
        assert runtime.command_view(command_id)["status"] == "succeeded"

    def test_failed_turn(self, rt):
        runtime, cp = rt.start()
        assert cp.completed(send(runtime, "[fail]"))["status"] == "failed"

    def test_interrupt_running_turn(self, rt):
        runtime, cp = rt.start()
        command_id = send(runtime, "[slow]")
        cp.wait_for("turn.started")
        runtime.interrupt(command_id)
        assert cp.completed(command_id)["status"] == "interrupted"

    def test_interrupt_queued_command(self, rt):
        runtime, cp = rt.start()
        first = send(runtime, "[slow]", seq=1)
        second = send(runtime, "later", seq=2)
        runtime.interrupt(second)
        assert cp.completed(second)["status"] == "interrupted"
        runtime.interrupt(first)
        cp.completed(first)
        assert runtime.command_view(second)["status"] == "interrupted"

    def test_approval_accept(self, rt):
        runtime, cp = rt.start()
        command_id = send(runtime, "[approve]")
        request = cp.wait_for("approval.requested")
        assert request["kind"] == "command"
        assert request["summary"]["command"] == "touch approved.txt"
        approval_id = request["approval_id"]
        assert runtime.decide(approval_id, "accept") == "accepted"
        assert cp.wait_for("approval.applied")["decision"] == "accept"
        assert cp.completed(command_id)["status"] == "completed"
        item = cp.wait_for("item.updated", command_id=command_id)["item"]
        assert item == IsPartialDict(kind="command", input="touch approved.txt")
        # Repeating the same decision is fine; a different one is not.
        assert runtime.decide(approval_id, "accept") == "accepted"
        assert runtime.decide(approval_id, "decline") == "not_pending"

    def test_interrupt_while_waiting_for_approval(self, rt):
        runtime, cp = rt.start()
        command_id = send(runtime, "[approve]")
        cp.wait_for("approval.requested")
        runtime.interrupt(command_id)
        assert cp.wait_for("approval.applied")["decision"] == "cancel"
        assert cp.completed(command_id)["status"] == "interrupted"

    def test_plugin_confirmation(self, rt):
        runtime, cp = rt.start()
        command_id = send(runtime, "[confirm]")
        request = cp.wait_for("approval.requested")
        assert request["kind"] == "elicitation"
        assert request["summary"] == {"server": "tasks", "message": "清空所有任务？"}
        assert runtime.decide(request["approval_id"], "accept") == "accepted"
        assert cp.wait_for("approval.applied")["decision"] == "accept"
        assert cp.completed(command_id)["status"] == "completed"
        assert reply_text(cp, command_id) == "确认结果：accept"

    def test_plugin_confirmation_declined(self, rt):
        runtime, cp = rt.start()
        command_id = send(runtime, "[confirm]")
        request = cp.wait_for("approval.requested")
        runtime.decide(request["approval_id"], "decline")
        cp.completed(command_id)
        assert reply_text(cp, command_id) == "确认结果：decline"

    def test_interrupt_while_waiting_for_confirmation(self, rt):
        runtime, cp = rt.start()
        command_id = send(runtime, "[confirm]")
        cp.wait_for("approval.requested")
        runtime.interrupt(command_id)
        assert cp.wait_for("approval.applied")["decision"] == "cancel"
        assert cp.completed(command_id)["status"] == "interrupted"

    def test_plugin_form_is_declined(self, rt):
        runtime, cp = rt.start()
        command_id = send(runtime, "[form]")
        cp.completed(command_id)
        assert reply_text(cp, command_id) == "确认结果：decline"
        assert not [e for e in cp.events if e["type"] == "approval.requested"]

    def test_compact_runs_as_a_turn(self, rt):
        runtime, cp = rt.start()
        command_id = send(runtime, "", kind="compact", payload={})
        assert cp.completed(command_id)["status"] == "completed"
        item = cp.wait_for("item.updated", command_id=command_id)["item"]
        assert item == IsPartialDict(kind="compaction")
        assert runtime.command_view(command_id)["status"] == "succeeded"

    def steer(self, runtime, target, text="改用中文", seq=2):
        steer_id = str(uuid.uuid4())
        body = {"command_id": steer_id, "agent_sequence": seq, "text": text}
        return steer_id, runtime.steer(target, body)

    def test_steer_hands_the_turn_to_the_steer(self, rt):
        runtime, cp = rt.start()
        first = send(runtime, "[steer]", seq=1)
        cp.wait_for("turn.started", command_id=first)
        steer_id, result = self.steer(runtime, first)
        assert result == "accepted"
        # Repeated delivery is a no-op.
        assert runtime.steer(first, {"command_id": steer_id}) == "accepted"
        steered = cp.wait_for("turn.steered", command_id=first)
        assert steered["steer_command_id"] == steer_id
        assert cp.completed(steer_id)["status"] == "completed"
        texts = {
            e["payload"]["command_id"]: e["payload"]["item"].get("text")
            for e in cp.events
            if e["type"] == "item.updated"
        }
        assert texts == {first: "收到：[steer]", steer_id: "收到插话：改用中文"}
        assert runtime.command_view(first)["status"] == "succeeded"
        assert runtime.command_view(steer_id)["status"] == "succeeded"
        assert "turn.completed" not in [
            e["type"] for e in cp.events if e["payload"].get("command_id") == first
        ]

    def test_steer_needs_a_running_turn(self, rt):
        runtime, cp = rt.start()
        done = send(runtime, "你好")
        cp.completed(done)
        assert self.steer(runtime, done)[1] == "not_running"
        assert self.steer(runtime, "missing")[1] == "not_found"

    def test_codex_crash_marks_outcome_unknown(self, rt):
        runtime, cp = rt.start()
        command_id = send(runtime, "[crash]")
        cp.wait_for("command.outcome_unknown", command_id=command_id)
        assert runtime.status == "error"


class TestItemDetail:
    def test_mcp_tool_shows_its_name_arguments_and_result(self):
        item = {
            "server": "memory",
            "tool": "recall",
            "arguments": {"query": "偏好"},
            "result": {"content": [{"type": "text", "text": "喜欢简洁"}]},
        }
        assert runtime_module._item_detail("mcp_tool", item) == (
            "memory.recall",
            '{"query": "偏好"}',
            "喜欢简洁",
        )

    def test_failed_mcp_tool_shows_the_error(self):
        item = {"server": "s", "tool": "t", "error": {"message": "boom"}}
        assert runtime_module._item_detail("mcp_tool", item) == ("s.t", "", "boom")

    def test_file_change_shows_paths_and_diffs(self):
        changes = [{"path": "a.py", "diff": "+a"}, {"path": "b.py", "diff": "+b"}]
        assert runtime_module._item_detail("file_change", {"changes": changes}) == (
            "",
            "a.py, b.py",
            "+a\n+b",
        )


class TestSnapshots:
    def test_every_turn_saves_a_snapshot_before_completing(self, rt):
        runtime, cp = rt.start()
        command_id = send(runtime, "你好")
        cp.completed(command_id)
        types = cp.types()
        assert types.index("snapshot.saved") < types.index("turn.completed")
        assert SNAPSHOT_URL in rt.objects

    def test_new_instance_restores_the_snapshot(self, rt):
        runtime, cp = rt.start()
        (runtime.settings.workspace_dir / "notes.md").write_text("记得这个")
        cp.completed(send(runtime, "hello"))
        thread_id = runtime.thread_id
        runtime.shutdown()

        # A new container starts with an empty home.
        restored, _ = rt.start(
            home_dir=rt.tmp / "home-2",
            snapshot_url=SNAPSHOT_URL,
            known_thread_id=thread_id,
            instance_id="i2",
            generation=2,
        )
        assert (restored.status, restored.thread_id) == ("ready", thread_id)
        notes = restored.settings.workspace_dir / "notes.md"
        assert notes.read_text() == "记得这个"

    def test_codex_scratch_files_are_left_out(self, rt):
        runtime, cp = rt.start()
        (runtime.settings.codex_home / "tmp").mkdir()
        (runtime.settings.codex_home / "tmp" / "scratch").write_text("x")
        (runtime.settings.codex_home / "state.lock").write_text("x")
        cp.completed(send(runtime, "hello"))
        runtime.shutdown()
        restored, _ = rt.start(
            home_dir=rt.tmp / "home-2",
            snapshot_url=SNAPSHOT_URL,
            known_thread_id=runtime.thread_id,
            instance_id="i2",
        )
        home = restored.settings.codex_home
        assert not (home / "tmp").exists()
        assert not (home / "state.lock").exists()

    def test_installed_plugins_are_left_out(self, rt):
        runtime, cp = rt.start()
        cp.completed(send(runtime, "hello"))
        listing = subprocess.run(
            ["tar", "--zstd", "-t"],
            input=rt.objects[SNAPSHOT_URL],
            capture_output=True,
            check=True,
        ).stdout.decode()
        assert "./codex/config.toml" in listing
        assert "plugins/cache" not in listing

    def test_failed_upload_is_reported_and_the_turn_still_completes(
        self, rt, monkeypatch
    ):
        def broken(url, path):
            raise OSError("S3 unavailable")

        monkeypatch.setattr(runtime_module, "upload", broken)
        runtime, cp = rt.start()
        command_id = send(runtime, "你好")
        assert cp.completed(command_id)["status"] == "completed"
        assert cp.wait_for("snapshot.failed") == {"reason": "SNAPSHOT_FAILED"}

    def test_unreadable_snapshot_fails_recovery(self, rt):
        rt.objects[SNAPSHOT_URL] = b"garbage"
        runtime, _ = rt.start(snapshot_url=SNAPSHOT_URL)
        assert (runtime.status, runtime.error_code) == (
            "recovery_failed",
            "RECOVERY_SNAPSHOT_INVALID",
        )

    def test_missing_snapshot_fails_recovery(self, rt):
        runtime, _ = rt.start(snapshot_url=SNAPSHOT_URL)
        assert runtime.error_code == "RECOVERY_DOWNLOAD_FAILED"


class TestControlMessages:
    def test_interrupt_decision_and_steer(self, rt):
        runtime, cp = rt.start()
        first = send(runtime, "[approve]", seq=1)
        request = cp.wait_for("approval.requested")
        decision = {"approval_id": request["approval_id"], "decision": "accept"}
        assert runtime.control({"type": "decision", **decision}) == {}
        assert cp.wait_for("approval.applied")["decision"] == "accept"
        cp.completed(first)
        slow = send(runtime, "[steer]", seq=2)
        cp.wait_for("turn.started", command_id=slow)
        steer = {"type": "steer", "command_id": "s1", "agent_sequence": 3, "text": "hi"}
        assert runtime.control(steer) == {"accepted": True}
        assert cp.completed("s1")["status"] == "completed"
        # With no turn running, a steer is refused and gets queued instead.
        assert runtime.control({**steer, "command_id": "s2"}) == {"accepted": False}
        later = send(runtime, "[slow]", seq=4)
        cp.wait_for("turn.started", command_id=later)
        runtime.control({"type": "interrupt", "command_id": later})
        assert cp.completed(later)["status"] == "interrupted"

    def test_runtime_takes_commands_from_the_queue(self, rt, monkeypatch):
        commands = [
            {
                "command_id": "q1",
                "kind": "turn",
                "agent_sequence": 1,
                "payload": {"text": "hi"},
            },
            {"command_id": "bad", "kind": "shell", "agent_sequence": 2},
        ]

        def take(self):
            time.sleep(0.02)
            return commands.pop(0) if commands else None

        monkeypatch.setattr(FakeQueue, "take", take)
        runtime, cp = rt.start()
        assert cp.completed("q1")["status"] == "completed"
        time.sleep(0.2)
        assert runtime.ledger.get_command("bad") is None
