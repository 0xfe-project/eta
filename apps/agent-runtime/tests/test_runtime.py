import hashlib
import json
import logging
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid
from dataclasses import replace
from pathlib import Path

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

    def transfer(self, method, url, path, headers=None):
        if method == "PUT":
            self.objects[url] = Path(path).read_bytes()
        else:
            Path(path).write_bytes(self.objects[url])

    def types(self):
        with self.lock:
            return [e["type"] for e in self.events]

    def wait_for(self, predicate, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                found = [e for e in self.events if predicate(e)]
            if found:
                return found[0]
            time.sleep(0.02)
        raise AssertionError(f"event not seen; got {self.types()}")


class RuntimeTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.settings = Settings(
            agent_id="agent-1",
            instance_id=str(uuid.uuid4()),
            generation=1,
            token="secret",
            control_plane_url="http://cp.invalid",
            listen_host="127.0.0.1",
            listen_port=0,
            workspace_dir=self.tmp / "workspace",
            state_dir=self.tmp / "state",
            known_thread_id=None,
            model=None,
            sandbox="workspace-write",
            approval_policy="on-request",
            codex_launch=FAKE,
            heartbeat_seconds=0.05,
            mcp_ready_timeout=5,
        )
        self.settings.workspace_dir.mkdir()
        self.runtimes: list[Runtime] = []

    def tearDown(self):
        for runtime in self.runtimes:
            runtime.shutdown()

    def start(self, cp=None, **changes) -> tuple[Runtime, StubControlPlane]:
        cp = cp or StubControlPlane()
        settings = replace(self.settings, **changes)
        runtime = Runtime(settings, cp)
        self.runtimes.append(runtime)
        runtime.boot()
        return runtime, cp

    def send(self, runtime, text, kind="turn", payload=None, seq=None):
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

    def completed(self, cp, command_id):
        return cp.wait_for(
            lambda e: (
                e["type"] == "turn.completed"
                and e["payload"]["command_id"] == command_id
            )
        )["payload"]


class BootTests(RuntimeTestCase):
    def test_first_boot_creates_and_registers_thread(self):
        runtime, cp = self.start()
        self.assertEqual(runtime.status, "ready")
        self.assertEqual(cp.sessions[0]["thread_id"], runtime.thread_id)
        self.assertFalse(cp.sessions[0]["resumed"])

    def test_restart_resumes_same_thread(self):
        first, _ = self.start()
        thread_id = first.thread_id
        first.shutdown()
        second, cp = self.start(instance_id=str(uuid.uuid4()), generation=2)
        self.assertEqual(second.status, "ready")
        self.assertEqual(second.thread_id, thread_id)
        self.assertTrue(cp.sessions[0]["resumed"])

    def test_lost_state_never_creates_replacement_thread(self):
        runtime, cp = self.start(known_thread_id="thread-from-control-plane")
        self.assertEqual(runtime.status, "recovery_failed")
        self.assertEqual(runtime.error_code, "RECOVERY_RESUME_FAILED")
        self.assertEqual(cp.sessions, [])

    def test_recorded_thread_must_match_control_plane(self):
        first, _ = self.start()
        first.shutdown()
        runtime, _ = self.start(known_thread_id="other", instance_id="i2")
        self.assertEqual(runtime.error_code, "RECOVERY_THREAD_MISMATCH")

    def test_control_plane_thread_conflict(self):
        runtime, _ = self.start(cp=StubControlPlane(thread_conflict=True))
        self.assertEqual(runtime.error_code, "RECOVERY_THREAD_MISMATCH")

    def test_required_mcp_module_must_start(self):
        module = McpModule("tasks", "1", True, [], "python3", [], {}, {})
        ok, _ = self.start(mcp_modules=[module])
        self.assertEqual(ok.status, "ready")
        ok.shutdown()
        os.environ["FAKE_MCP_FAIL"] = "tasks"
        self.addCleanup(os.environ.pop, "FAKE_MCP_FAIL")
        failed, cp = self.start(mcp_modules=[module], instance_id="i3")
        self.assertEqual(failed.status, "error")
        self.assertEqual(failed.error_code, "MCP_REQUIRED_FAILED")

    def test_unusable_workspace_is_not_ready(self):
        blocked = self.tmp / "blocked"
        blocked.write_text("not a directory")
        runtime, _ = self.start(workspace_dir=blocked)
        self.assertEqual(runtime.status, "error")
        self.assertEqual(runtime.error_code, "MOUNT_FAILED")


class TurnTests(RuntimeTestCase):
    def test_turn_streams_items_and_completes(self):
        runtime, cp = self.start()
        command_id = self.send(runtime, "你好")
        result = self.completed(cp, command_id)
        self.assertEqual(result["status"], "completed")
        items = [
            e["payload"]["item"]
            for e in cp.events
            if e["type"] == "item.updated" and e["payload"]["command_id"] == command_id
        ]
        self.assertEqual(items[-1]["kind"], "agent_message")
        self.assertEqual(items[-1]["status"], "completed")
        self.assertEqual(items[-1]["text"], "收到：你好")
        seqs = [e["source_seq"] for e in cp.events]
        self.assertEqual(seqs, list(range(1, len(seqs) + 1)))
        self.assertEqual(runtime.command_view(command_id)["status"], "succeeded")

    def test_accept_is_idempotent_and_detects_conflicts(self):
        runtime, _ = self.start()
        body = {"kind": "turn", "agent_sequence": 1, "payload": {"text": "a"}}
        runtime.accept("c1", body)
        runtime.accept("c1", body)
        with self.assertRaises(L.CommandConflict):
            runtime.accept("c1", {**body, "payload": {"text": "b"}})

    def test_failed_turn(self):
        runtime, cp = self.start()
        command_id = self.send(runtime, "[fail]")
        self.assertEqual(self.completed(cp, command_id)["status"], "failed")

    def test_interrupt_running_turn(self):
        runtime, cp = self.start()
        command_id = self.send(runtime, "[slow]")
        cp.wait_for(lambda e: e["type"] == "turn.started")
        runtime.interrupt(command_id)
        self.assertEqual(self.completed(cp, command_id)["status"], "interrupted")

    def test_interrupt_queued_command(self):
        runtime, cp = self.start()
        first = self.send(runtime, "[slow]", seq=1)
        second = self.send(runtime, "later", seq=2)
        runtime.interrupt(second)
        self.assertEqual(self.completed(cp, second)["status"], "interrupted")
        runtime.interrupt(first)
        self.completed(cp, first)
        self.assertEqual(runtime.command_view(second)["status"], "interrupted")

    def test_approval_accept(self):
        runtime, cp = self.start()
        command_id = self.send(runtime, "[approve]")
        request = cp.wait_for(lambda e: e["type"] == "approval.requested")["payload"]
        self.assertEqual(request["kind"], "command")
        self.assertEqual(request["summary"]["command"], "touch approved.txt")
        self.assertEqual(runtime.decide(request["approval_id"], "accept", 2), "stale")
        self.assertEqual(
            runtime.decide(request["approval_id"], "accept", 1), "accepted"
        )
        applied = cp.wait_for(lambda e: e["type"] == "approval.applied")["payload"]
        self.assertEqual(applied["decision"], "accept")
        self.assertEqual(self.completed(cp, command_id)["status"], "completed")
        # Repeating the same decision is fine; a different one is not.
        self.assertEqual(
            runtime.decide(request["approval_id"], "accept", 1), "accepted"
        )
        self.assertEqual(
            runtime.decide(request["approval_id"], "decline", 1), "not_pending"
        )

    def test_interrupt_while_waiting_for_approval(self):
        runtime, cp = self.start()
        command_id = self.send(runtime, "[approve]")
        cp.wait_for(lambda e: e["type"] == "approval.requested")
        runtime.interrupt(command_id)
        applied = cp.wait_for(lambda e: e["type"] == "approval.applied")["payload"]
        self.assertEqual(applied["decision"], "cancel")
        self.assertEqual(self.completed(cp, command_id)["status"], "interrupted")

    def test_codex_crash_marks_outcome_unknown_and_restart_keeps_it(self):
        runtime, cp = self.start()
        command_id = self.send(runtime, "[crash]")
        cp.wait_for(
            lambda e: (
                e["type"] == "command.outcome_unknown"
                and e["payload"]["command_id"] == command_id
            )
        )
        self.assertEqual(runtime.status, "error")
        runtime.shutdown()
        restarted, _ = self.start(instance_id="i2", generation=2)
        self.assertEqual(restarted.status, "ready")
        self.assertEqual(
            restarted.command_view(command_id)["status"], "outcome_unknown"
        )


class RecoveryTests(RuntimeTestCase):
    def test_reconcile_completed_running_turn_and_unknown_start(self):
        runtime, cp = self.start()
        done = self.send(runtime, "hello")
        self.completed(cp, done)
        thread_id = runtime.thread_id
        runtime.shutdown()
        # Simulate a crash: the ledger still thinks one turn runs and another
        # was being started.
        ledger = L.Ledger(self.settings.ledger_path, "x")
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

        restarted, cp2 = self.start(instance_id="i2", generation=2)
        self.assertEqual(restarted.thread_id, thread_id)
        self.assertEqual(self.completed(cp2, done)["status"], "completed")
        cp2.wait_for(
            lambda e: (
                e["type"] == "command.outcome_unknown"
                and e["payload"]["command_id"] == "starting"
            )
        )
        cp2.wait_for(lambda e: e["type"] == "approval.expired")
        # Outbox sequences restart per instance.
        self.assertEqual(cp2.events[0]["source_seq"], 1)

    def test_checkpoint_round_trip(self):
        runtime, cp = self.start()
        self.completed(cp, self.send(runtime, "before checkpoint"))
        url = "http://objects.invalid/ckpt-1"
        command_id = self.send(
            runtime,
            "",
            kind="checkpoint",
            payload={"checkpoint_id": "ckpt-1", "upload": {"url": url}},
        )
        done = cp.wait_for(lambda e: e["type"] == "checkpoint.completed")["payload"]
        self.assertEqual(done["command_id"], command_id)
        archive = cp.objects[url]
        self.assertEqual(done["checksum"], hashlib.sha256(archive).hexdigest())
        self.assertEqual(done["manifest"]["thread_id"], runtime.thread_id)
        self.assertFalse(done["manifest"]["workspace"]["included"])
        # The runtime is usable again after the pause.
        self.assertEqual(
            self.completed(cp, self.send(runtime, "after"))["status"], "completed"
        )
        thread_id = runtime.thread_id
        runtime.shutdown()

        # A new host with empty state restores from the checkpoint.
        restore = {"checkpoint_id": "ckpt-1", "url": url, "checksum": done["checksum"]}
        restored, cp2 = self.start(
            cp=cp,
            state_dir=self.tmp / "state-2",
            restore=restore,
            known_thread_id=thread_id,
            instance_id="i5",
            generation=3,
        )
        self.assertEqual(restored.status, "ready")
        self.assertEqual(restored.thread_id, thread_id)

    def test_restore_rejects_bad_checksum(self):
        cp = StubControlPlane()
        cp.objects["u"] = b"garbage"
        runtime, _ = self.start(
            cp=cp, restore={"checkpoint_id": "c", "url": "u", "checksum": "0" * 64}
        )
        self.assertEqual(runtime.error_code, "RECOVERY_CHECKSUM_MISMATCH")


class ServerTests(RuntimeTestCase):
    def setUp(self):
        super().setUp()
        self.runtime, self.cp = self.start()
        self.server = serve(self.runtime)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}/internal/v1"

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

    def test_auth_and_status(self):
        self.assertEqual(self.call("GET", "/status", token="wrong")[0], 403)
        status, body = self.call("GET", "/status")
        self.assertEqual(status, 200)
        self.assertEqual(body["thread_id"], self.runtime.thread_id)

    def test_command_lifecycle_over_http(self):
        body = {
            "kind": "turn",
            "agent_id": "agent-1",
            "generation": 1,
            "agent_sequence": 1,
            "payload": {"text": "hi"},
        }
        self.assertEqual(
            self.call("PUT", "/commands/c1", {**body, "generation": 9})[0], 409
        )
        self.assertEqual(
            self.call("PUT", "/commands/c1", {**body, "agent_id": "x"})[0], 409
        )
        status, view = self.call("PUT", "/commands/c1", body)
        self.assertEqual(status, 202)
        self.assertEqual(self.call("PUT", "/commands/c1", body)[0], 202)
        conflict = {**body, "payload": {"text": "other"}}
        self.assertEqual(self.call("PUT", "/commands/c1", conflict)[0], 409)
        self.completed(self.cp, "c1")
        status, view = self.call("GET", "/commands/c1")
        self.assertEqual(view["status"], "succeeded")
        self.assertEqual(self.call("GET", "/commands/nope")[0], 404)
        status, _ = self.call("POST", "/commands/c1/interrupt", {"generation": 1})
        self.assertEqual(status, 202)
        self.assertEqual(
            self.call("PUT", "/approvals/x/decision", {"decision": "maybe"})[0], 400
        )
        self.assertEqual(
            self.call(
                "PUT", "/approvals/x/decision", {"decision": "accept", "generation": 1}
            )[0],
            409,
        )


if __name__ == "__main__":
    unittest.main()
