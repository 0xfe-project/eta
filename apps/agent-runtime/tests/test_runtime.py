import json
import logging
import os
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import replace
from pathlib import Path

import pytest
from dirty_equals import IsPartialDict

from axp_runtime import runtime as runtime_module
from axp_runtime.config import McpModule, Settings
from axp_runtime.control_plane import ControlPlaneError
from axp_runtime.runtime import Runtime
from axp_runtime.server import serve

FAKE = [sys.executable, "-m", "axp_runtime.testing.fake_app_server"]
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
            listen_host="127.0.0.1",
            listen_port=0,
            home_dir=tmp / "home",
            known_thread_id=None,
            model=None,
            sandbox="workspace-write",
            approval_policy="on-request",
            codex_launch=FAKE,
            heartbeat_seconds=0.05,
            mcp_ready_timeout=5,
        )
        self.runtimes: list[Runtime] = []

    def start(self, cp=None, **changes) -> tuple[Runtime, StubControlPlane]:
        cp = cp or StubControlPlane()
        runtime = Runtime(replace(self.settings, **changes), cp)
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

    def test_required_mcp_module_must_start(self, rt, monkeypatch):
        module = McpModule("tasks", "1", True, [], "python3", [], {}, {})
        ok, _ = rt.start(mcp_modules=[module])
        assert ok.status == "ready"
        ok.shutdown()
        monkeypatch.setenv("FAKE_MCP_FAIL", "tasks")
        failed, _ = rt.start(mcp_modules=[module], instance_id="i3")
        assert (failed.status, failed.error_code) == ("error", "MCP_REQUIRED_FAILED")


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
        assert runtime.decide(approval_id, "accept", 2) == "stale"
        assert runtime.decide(approval_id, "accept", 1) == "accepted"
        assert cp.wait_for("approval.applied")["decision"] == "accept"
        assert cp.completed(command_id)["status"] == "completed"
        item = cp.wait_for("item.updated", command_id=command_id)["item"]
        assert item == IsPartialDict(kind="command", input="touch approved.txt")
        # Repeating the same decision is fine; a different one is not.
        assert runtime.decide(approval_id, "accept", 1) == "accepted"
        assert runtime.decide(approval_id, "decline", 1) == "not_pending"

    def test_interrupt_while_waiting_for_approval(self, rt):
        runtime, cp = rt.start()
        command_id = send(runtime, "[approve]")
        cp.wait_for("approval.requested")
        runtime.interrupt(command_id)
        assert cp.wait_for("approval.applied")["decision"] == "cancel"
        assert cp.completed(command_id)["status"] == "interrupted"

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


class TestServer:
    @pytest.fixture(autouse=True)
    def _serve(self, rt):
        self.runtime, self.cp = rt.start()
        server = serve(self.runtime)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{server.server_address[1]}/internal/v1"
        yield
        server.shutdown()
        server.server_close()

    def call(self, method, path, body=None, token="secret"):
        request = urllib.request.Request(
            self.base + path,
            data=json.dumps(body).encode() if body is not None else None,
            method=method,
        )
        request.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def status(self, method, path, body=None):
        return self.call(method, path, body)[0]

    def test_auth_and_status(self):
        assert self.call("GET", "/status", token="wrong")[0] == 403
        status, body = self.call("GET", "/status")
        assert status == 200
        assert body["thread_id"] == self.runtime.thread_id

    def test_command_lifecycle_over_http(self):
        body = {
            "kind": "turn",
            "agent_id": "agent-1",
            "generation": 1,
            "agent_sequence": 1,
            "payload": {"text": "hi"},
        }
        assert self.status("PUT", "/commands/c1", {**body, "generation": 9}) == 409
        assert self.status("PUT", "/commands/c1", {**body, "agent_id": "x"}) == 409
        assert self.status("PUT", "/commands/c1", body) == 202
        assert self.status("PUT", "/commands/c1", body) == 202
        conflict = {**body, "payload": {"text": "other"}}
        assert self.status("PUT", "/commands/c1", conflict) == 409
        self.cp.completed("c1")
        interrupt = {"generation": 1}
        assert self.status("POST", "/commands/c1/interrupt", interrupt) == 202
        decision = "/approvals/x/decision"
        assert self.status("PUT", decision, {"decision": "maybe"}) == 400
        assert (
            self.status("PUT", decision, {"decision": "accept", "generation": 1}) == 409
        )
