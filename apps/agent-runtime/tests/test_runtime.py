import hashlib
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

from axp_runtime import ledger as L
from axp_runtime.config import McpModule, Settings
from axp_runtime.control_plane import ControlPlaneError
from axp_runtime.runtime import Runtime
from axp_runtime.server import serve

FAKE = [sys.executable, "-m", "axp_runtime.testing.fake_app_server"]
# Crash scenarios log expected tracebacks.
logging.disable(logging.CRITICAL)
# The scripted app-server runs from the workspace directory.
os.environ["PYTHONPATH"] = str(Path(__file__).resolve().parent.parent)


class StubControlPlane:
    """Records what the runtime reports; acks every event batch."""

    def __init__(self, thread_conflict=False):
        self.events: list[dict] = []
        self.sessions: list[dict] = []
        self.heartbeats: list[dict] = []
        self.objects: dict[str, bytes] = {}
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

    def transfer(self, method, url, path):
        if method == "PUT":
            self.objects[url] = Path(path).read_bytes()
        else:
            Path(path).write_bytes(self.objects[url])

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
    """Starts runtimes against stub control planes; shuts them all down."""

    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.settings = Settings(
            agent_id="agent-1",
            instance_id=str(uuid.uuid4()),
            generation=1,
            token="secret",
            control_plane_url="http://cp.invalid",
            listen_host="127.0.0.1",
            listen_port=0,
            workspace_dir=tmp / "workspace",
            state_dir=tmp / "state",
            known_thread_id=None,
            model=None,
            sandbox="workspace-write",
            approval_policy="on-request",
            codex_launch=FAKE,
            llm_base_url="http://llm-gateway:8317/v1",
            heartbeat_seconds=0.05,
            mcp_ready_timeout=5,
        )
        self.settings.workspace_dir.mkdir()
        self.runtimes: list[Runtime] = []

    def start(self, cp=None, **changes) -> tuple[Runtime, StubControlPlane]:
        cp = cp or StubControlPlane()
        runtime = Runtime(replace(self.settings, **changes), cp)
        self.runtimes.append(runtime)
        runtime.boot()
        return runtime, cp


@pytest.fixture
def rt(tmp_path):
    harness = Harness(tmp_path)
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
            'model_providers.axp.base_url="http://llm-gateway:8317/v1"',
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
        second, cp = rt.start(instance_id=str(uuid.uuid4()), generation=2)
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
            developer_instructions="只用中文回答。", instance_id="i2", generation=2
        )
        assert instructions(second) == "只用中文回答。"

    def test_lost_state_never_creates_replacement_thread(self, rt):
        runtime, cp = rt.start(known_thread_id="thread-from-control-plane")
        assert (runtime.status, runtime.error_code) == (
            "recovery_failed",
            "RECOVERY_RESUME_FAILED",
        )
        assert cp.sessions == []

    def test_recorded_thread_must_match_control_plane(self, rt):
        first, _ = rt.start()
        first.shutdown()
        runtime, _ = rt.start(known_thread_id="other", instance_id="i2")
        assert runtime.error_code == "RECOVERY_THREAD_MISMATCH"

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

    def test_unusable_workspace_is_not_ready(self, rt):
        blocked = rt.tmp / "blocked"
        blocked.write_text("not a directory")
        runtime, _ = rt.start(workspace_dir=blocked)
        assert (runtime.status, runtime.error_code) == ("error", "MOUNT_FAILED")


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

    def test_codex_crash_marks_outcome_unknown_and_restart_keeps_it(self, rt):
        runtime, cp = rt.start()
        command_id = send(runtime, "[crash]")
        cp.wait_for("command.outcome_unknown", command_id=command_id)
        assert runtime.status == "error"
        runtime.shutdown()
        restarted, _ = rt.start(instance_id="i2", generation=2)
        assert restarted.status == "ready"
        assert restarted.command_view(command_id)["status"] == "outcome_unknown"


class TestRecovery:
    def test_reconcile_completed_running_turn_and_unknown_start(self, rt):
        runtime, cp = rt.start()
        done = send(runtime, "hello")
        cp.completed(done)
        thread_id = runtime.thread_id
        runtime.shutdown()
        # Simulate a crash: the ledger still thinks one turn runs and another
        # was being started.
        ledger = L.Ledger(rt.settings.ledger_path, "x")
        ledger.update_command(done, status=L.RUNNING)
        ledger.accept_command(
            "starting",
            agent_sequence=99,
            kind="turn",
            payload={},
            request_hash="h",
            generation=1,
        )
        ledger.update_command("starting", status=L.STARTING)
        ledger.add_approval(
            "old-approval", done, 1, "item/commandExecution/requestApproval"
        )
        ledger.close()

        restarted, cp2 = rt.start(instance_id="i2", generation=2)
        assert restarted.thread_id == thread_id
        assert cp2.completed(done)["status"] == "completed"
        cp2.wait_for("command.outcome_unknown", command_id="starting")
        cp2.wait_for("approval.expired")
        # Outbox sequences restart per instance.
        assert cp2.events[0]["source_seq"] == 1

    def test_checkpoint_round_trip(self, rt):
        runtime, cp = rt.start()
        cp.completed(send(runtime, "before checkpoint"))
        url = "http://objects.invalid/ckpt-1"
        command_id = send(
            runtime,
            "",
            kind="checkpoint",
            payload={"checkpoint_id": "ckpt-1", "upload_url": url},
        )
        done = cp.wait_for("checkpoint.completed")
        assert done["command_id"] == command_id
        assert done["checksum"] == hashlib.sha256(cp.objects[url]).hexdigest()
        assert done["manifest"]["thread_id"] == runtime.thread_id
        assert not done["manifest"]["workspace"]["included"]
        # The runtime is usable again after the pause.
        assert cp.completed(send(runtime, "after"))["status"] == "completed"
        thread_id = runtime.thread_id
        runtime.shutdown()

        # A new host with empty state restores from the checkpoint.
        restore = {"checkpoint_id": "ckpt-1", "url": url, "checksum": done["checksum"]}
        restored, _ = rt.start(
            cp=cp,
            state_dir=rt.tmp / "state-2",
            restore=restore,
            known_thread_id=thread_id,
            instance_id="i5",
            generation=3,
        )
        assert (restored.status, restored.thread_id) == ("ready", thread_id)

    def test_restore_rejects_bad_checksum(self, rt):
        cp = StubControlPlane()
        cp.objects["u"] = b"garbage"
        runtime, _ = rt.start(
            cp=cp, restore={"checkpoint_id": "c", "url": "u", "checksum": "0" * 64}
        )
        assert runtime.error_code == "RECOVERY_CHECKSUM_MISMATCH"


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
        assert self.call("GET", "/commands/c1")[1]["status"] == "succeeded"
        assert self.status("GET", "/commands/nope") == 404
        interrupt = {"generation": 1}
        assert self.status("POST", "/commands/c1/interrupt", interrupt) == 202
        decision = "/approvals/x/decision"
        assert self.status("PUT", decision, {"decision": "maybe"}) == 400
        assert (
            self.status("PUT", decision, {"decision": "accept", "generation": 1}) == 409
        )
