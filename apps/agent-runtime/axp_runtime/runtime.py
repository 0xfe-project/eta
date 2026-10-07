"""Agent runtime: one persistent Codex thread driven through the Python SDK.

Startup: verify mounts -> restore state if asked -> start Codex -> resume the
recorded thread (or create it once) -> wait for required MCP modules ->
reconcile unfinished commands and approvals -> report ready.
"""

import hashlib
import json
import logging
import os
import shutil
import tarfile
import tempfile
import threading
import time
import uuid
from pathlib import Path

from openai_codex import CodexConfig
from openai_codex import __version__ as SDK_VERSION
from openai_codex.client import CodexClient
from openai_codex.errors import CodexError, JsonRpcError, TransportClosedError
from openai_codex.generated.v2_all import TurnSteerResponse
from openai_codex.models import UnknownNotification
from pydantic import BaseModel, ConfigDict

from . import ledger as L
from .config import PROTOCOL_VERSION, Settings
from .control_plane import ControlPlane, ControlPlaneError, Fenced

logger = logging.getLogger(__name__)

THREAD_KEY = "thread_id"
# Codex model provider id for the LLM gateway.
LLM_PROVIDER = "axp"
APPROVAL_METHODS = {
    "item/commandExecution/requestApproval": "command",
    "item/fileChange/requestApproval": "file_change",
}
# Conservative answers for server requests the product does not surface.
DECLINE_RESPONSES = {
    "item/permissions/requestApproval": {"permissions": {}},
    "mcpServer/elicitation/request": {"action": "decline"},
    "item/tool/requestUserInput": {"answers": {}},
    "execCommandApproval": {"decision": "denied"},
    "applyPatchApproval": {"decision": "denied"},
    "item/tool/call": {"contentItems": [], "success": False},
}
ITEM_KINDS = {
    "agentMessage": "agent_message",
    "commandExecution": "command",
    "fileChange": "file_change",
    "mcpToolCall": "mcp_tool",
    "dynamicToolCall": "tool",
    "webSearch": "web_search",
    "collabAgentToolCall": "agent",
    "imageGeneration": "image",
    "contextCompaction": "compaction",
}
FAILED_ITEM_STATUSES = {"failed", "declined", "error"}
FLUSH_SECONDS = 0.3
# thread/compact/start answers before its turn starts.
COMPACT_START_SECONDS = 30


class RecoveryFailed(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}")
        self.code = code


class _Lenient(BaseModel):
    model_config = ConfigDict(extra="allow")


class _ThreadResponse(_Lenient):
    thread: dict


class _ApprovalWaiter:
    def __init__(self, command_id: str):
        self.command_id = command_id
        self.event = threading.Event()
        self.decision: str | None = None


def _payload(notification) -> dict:
    payload = notification.payload
    if isinstance(payload, UnknownNotification):
        return payload.params
    if isinstance(payload, BaseModel):
        # The SDK's generated unions do not always match the item they hold,
        # so pydantic warns while serializing; the JSON is still complete.
        return payload.model_dump(
            mode="json", by_alias=True, exclude_none=True, warnings=False
        )
    return {}


def _toml(value) -> str:
    """Render a config override value; JSON strings/arrays are valid TOML."""
    if isinstance(value, dict):
        inner = ", ".join(f"{json.dumps(k)} = {_toml(v)}" for k, v in value.items())
        return "{" + inner + "}"
    return json.dumps(value)


class Runtime:
    def __init__(self, settings: Settings, control_plane: ControlPlane | None = None):
        self.settings = settings
        self.cp = control_plane or ControlPlane(settings)
        self.ledger: L.Ledger | None = None
        self.client: CodexClient | None = None
        self.status = "starting"
        self.error_code: str | None = None
        self.thread_id: str | None = None
        self.codex_version: str | None = None
        self.current_command_id: str | None = None
        self.mcp_status: dict[str, dict] = {}
        self._mcp_changed = threading.Condition()
        self._approvals: dict[str, _ApprovalWaiter] = {}
        # Steer command id -> its command, from turn/steer until the running
        # turn takes it in.
        self._steers: dict[str, dict] = {}
        self._lock = threading.RLock()
        self._wake = threading.Event()
        # stopping: take no new work. _halt: stop the background loops, once
        # shutdown has let them deliver what is pending.
        self.stopping = threading.Event()
        self._halt = threading.Event()
        self._shutdown_lock = threading.Lock()
        # Held while a turn starts and while Codex stops, so a turn is either
        # fully started (and recorded) or not started at all.
        self._codex_lock = threading.Lock()
        self._threads: list[threading.Thread] = []

    # --- lifecycle ----------------------------------------------------------

    def boot(self) -> None:
        """Bring the runtime to ready, or record why it cannot be."""
        try:
            self._spawn(self._heartbeat_loop, "heartbeat")
            self._verify_workspace()
            self._restore_if_needed()
            self.ledger = L.Ledger(self.settings.ledger_path, self.settings.instance_id)
            self._spawn(self._outbox_loop, "outbox")
            self._reconcile_before_codex()
            self._start_codex()
            self._open_thread()
            self._wait_for_mcp()
            self._reconcile_turns()
        except RecoveryFailed as exc:
            logger.error("Runtime not ready: %s", exc)
            self.error_code = exc.code
            self.status = (
                "recovery_failed" if exc.code.startswith("RECOVERY") else "error"
            )
            if self.ledger:
                self.ledger.emit(
                    "runtime.failed", {"status": self.status, "code": exc.code}
                )
            return
        self.status = "ready"
        self._spawn(self._worker_loop, "worker")

    def shutdown(self, timeout: float = 8) -> None:
        """Stop gracefully within ``timeout`` seconds.

        Takes no new work, cancels pending approvals, stops Codex, lets the
        worker finish, delivers pending events, then closes the ledger.
        Unfinished commands stay in the ledger; the next instance reconciles
        them against the Codex thread.
        """
        if not self._shutdown_lock.acquire(blocking=False):
            return  # already shutting down
        deadline = time.monotonic() + timeout
        self.stopping.set()
        self._wake.set()
        self._cancel_approvals()
        with self._codex_lock:
            self._stop_codex()
        self._join(deadline, "worker", "codex-global")
        if self.ledger:
            try:
                self._wait_outbox_drained(max(0.0, deadline - time.monotonic()))
            except TimeoutError:
                logger.warning("Stopping with undelivered events")
        self._halt.set()
        if self._join(deadline) and self.ledger:
            self.ledger.close()
        elif self.ledger:
            logger.warning("Background threads still running; ledger left open")

    def fence(self) -> None:
        """Stop doing anything as soon as the control plane rejects us."""
        logger.error("Fenced by the control plane; exiting")
        self.stopping.set()
        self._halt.set()
        self._cancel_approvals()
        with self._codex_lock:
            self._stop_codex()
        os._exit(3)

    def _cancel_approvals(self) -> None:
        with self._lock:
            for waiter in self._approvals.values():
                waiter.decision = waiter.decision or "cancel"
                waiter.event.set()

    def _spawn(self, target, name: str) -> None:
        thread = threading.Thread(target=target, name=name, daemon=True)
        thread.start()
        self._threads.append(thread)

    def _join(self, deadline: float, *names: str) -> bool:
        """Wait for our threads (or the named ones); True if all stopped."""
        current = threading.current_thread()
        for thread in self._threads:
            if thread is current or (names and thread.name not in names):
                continue
            thread.join(max(0.0, deadline - time.monotonic()))
        return not any(
            t.is_alive() and t is not current
            for t in self._threads
            if not names or t.name in names
        )

    # --- state preparation --------------------------------------------------

    def _verify_workspace(self) -> None:
        workspace = self.settings.workspace_dir
        try:
            probe = workspace / ".axp" / "probe"
            probe.parent.mkdir(parents=True, exist_ok=True)
            probe.write_text(str(time.time()))
            probe.unlink()
        except OSError as exc:
            raise RecoveryFailed("MOUNT_FAILED", str(exc)) from exc
        self.settings.state_dir.mkdir(parents=True, exist_ok=True)

    def _restore_if_needed(self) -> None:
        restore = self.settings.restore
        state = self.settings.state_dir
        if not restore or self.settings.ledger_path.exists():
            return
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "checkpoint.tar.gz"
            try:
                self.cp.transfer("GET", restore["url"], archive)
            except Exception as exc:
                raise RecoveryFailed("RECOVERY_DOWNLOAD_FAILED", str(exc)) from exc
            if _sha256(archive) != restore["checksum"]:
                raise RecoveryFailed("RECOVERY_CHECKSUM_MISMATCH")
            with tarfile.open(archive) as tar:
                tar.extractall(state, filter="data")
        logger.info("Restored state from checkpoint %s", restore["checkpoint_id"])

    # --- Codex --------------------------------------------------------------

    def _codex_config(self) -> CodexConfig:
        overrides = []
        for module in self.settings.mcp_modules:
            prefix = f"mcp_servers.{module.module_key}"
            env = {
                **module.env,
                "AXP_MCP_CONFIG": json.dumps(module.config),
                "AXP_WORKSPACE_DIR": str(self.settings.workspace_dir),
            }
            overrides += [
                f"{prefix}.command={_toml(module.command)}",
                f"{prefix}.args={_toml(module.args)}",
                f"{prefix}.env={_toml(env)}",
                f"{prefix}.required={_toml(module.required)}",
            ]
            if module.allowed_tools:
                overrides.append(
                    f"{prefix}.enabled_tools={_toml(module.allowed_tools)}"
                )
        # Every model request goes through the LLM gateway, authenticated as
        # this runtime instance; the container holds no provider credentials.
        overrides += [
            f"model_provider={_toml(LLM_PROVIDER)}",
            f"model_providers.{LLM_PROVIDER}.name={_toml('AXP LLM Gateway')}",
            f"model_providers.{LLM_PROVIDER}.base_url={_toml(self.settings.llm_base_url)}",
            f"model_providers.{LLM_PROVIDER}.wire_api={_toml('responses')}",
            f"model_providers.{LLM_PROVIDER}.env_key={_toml('AXP_RUNTIME_LLM_KEY')}",
        ]
        if self.settings.model_context_window:
            overrides.append(
                f"model_context_window={_toml(self.settings.model_context_window)}"
            )
        overrides += _otel_overrides()
        env = {
            "CODEX_HOME": str(self.settings.codex_home),
            "AXP_WORKSPACE_DIR": str(self.settings.workspace_dir),
            "AXP_RUNTIME_LLM_KEY": f"{self.settings.instance_id}.{self.settings.token}",
        }
        launch = None
        if self.settings.codex_launch:
            # A custom launcher gets the same overrides the SDK would pass.
            launch = [*self.settings.codex_launch]
            for override in overrides:
                launch += ["--config", override]
        return CodexConfig(
            launch_args_override=tuple(launch) if launch else None,
            config_overrides=tuple(overrides),
            cwd=str(self.settings.workspace_dir),
            env=env,
            client_name="axp_runtime",
            client_title="AXP Agent Runtime",
        )

    def _start_codex(self) -> None:
        self.settings.codex_home.mkdir(parents=True, exist_ok=True)
        client = CodexClient(self._codex_config(), approval_handler=self._on_request)
        try:
            client.start()
            info = client.initialize()
        except Exception as exc:
            _close_client(client)
            raise RecoveryFailed("CODEX_START_FAILED", str(exc)) from exc
        self.codex_version = (info.serverInfo.version if info.serverInfo else None) or (
            info.userAgent
        )
        with self._codex_lock:
            if self.stopping.is_set():
                _close_client(client)
                raise RecoveryFailed("SHUTTING_DOWN")
            self.client = client
        self._spawn(self._drain_global, "codex-global")

    def _stop_codex(self) -> None:
        client, self.client = self.client, None
        if client:
            _close_client(client)

    def _thread_params(self) -> dict:
        params = {
            "cwd": str(self.settings.workspace_dir),
            "approvalPolicy": self.settings.approval_policy,
            "approvalsReviewer": "user",
            "sandbox": self.settings.sandbox,
        }
        if self.settings.model:
            params["model"] = self.settings.model
        if self.settings.developer_instructions:
            params["developerInstructions"] = self.settings.developer_instructions
        return params

    def _open_thread(self) -> None:
        recorded = self.ledger.get_meta(THREAD_KEY)
        known = self.settings.known_thread_id
        if recorded and known and recorded != known:
            raise RecoveryFailed("RECOVERY_THREAD_MISMATCH")
        thread_id = recorded or known
        if thread_id:
            try:
                self.client.request(
                    "thread/resume",
                    {"threadId": thread_id, **self._thread_params()},
                    response_model=_ThreadResponse,
                )
            except (CodexError, JsonRpcError) as exc:
                # Never replace a thread that cannot be resumed.
                raise RecoveryFailed("RECOVERY_RESUME_FAILED", str(exc)) from exc
            resumed = True
        else:
            if self.ledger.has_commands():
                raise RecoveryFailed("RECOVERY_STATE_LOST")
            started = self.client.request(
                "thread/start", self._thread_params(), response_model=_ThreadResponse
            )
            thread_id = started.thread["id"]
            self.ledger.set_meta(THREAD_KEY, thread_id)
            resumed = False
        if not recorded:
            self.ledger.set_meta(THREAD_KEY, thread_id)
        self.thread_id = thread_id
        try:
            self.cp.register_session(
                {
                    "thread_id": thread_id,
                    "resumed": resumed,
                    "sdk_version": SDK_VERSION,
                    "runtime_version": self.codex_version,
                }
            )
        except ControlPlaneError as exc:
            if exc.status == 409:
                raise RecoveryFailed("RECOVERY_THREAD_MISMATCH") from exc
            raise

    def _drain_global(self) -> None:
        client = self.client
        while client is self.client and not self.stopping.is_set():
            try:
                notification = client.next_notification()
            except Exception:
                return
            if notification.method == "mcpServer/startupStatus/updated":
                payload = _payload(notification)
                status = {
                    "status": payload.get("status"),
                    "error": payload.get("error"),
                }
                with self._mcp_changed:
                    self.mcp_status[payload.get("name", "")] = status
                    self._mcp_changed.notify_all()
                if self.ledger:
                    self.ledger.emit(
                        "mcp.status",
                        {"module_key": payload.get("name"), "status": status["status"]},
                    )

    def _wait_for_mcp(self) -> None:
        required = [m.module_key for m in self.settings.mcp_modules if m.required]
        deadline = time.monotonic() + self.settings.mcp_ready_timeout
        with self._mcp_changed:
            while True:
                states = {
                    key: self.mcp_status.get(key, {}).get("status") for key in required
                }
                failed = [k for k, s in states.items() if s in ("failed", "cancelled")]
                if failed:
                    raise RecoveryFailed("MCP_REQUIRED_FAILED", ",".join(failed))
                if all(s == "ready" for s in states.values()):
                    return
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RecoveryFailed("MCP_REQUIRED_TIMEOUT", ",".join(required))
                self._mcp_changed.wait(remaining)

    # --- reconciliation -----------------------------------------------------

    def _reconcile_before_codex(self) -> None:
        # A crash between recording intent and learning the turn id cannot be
        # proven harmless, so it is never replayed.
        for command in self.ledger.commands_with_status(L.STARTING):
            self._finish_unknown(command)
        for approval in self.ledger.pending_approvals():
            if approval["generation"] != self.settings.generation:
                self.ledger.set_approval(approval["approval_id"], "expired")
                self.ledger.emit(
                    "approval.expired", {"approval_id": approval["approval_id"]}
                )

    def _reconcile_turns(self) -> None:
        running = self.ledger.commands_with_status(L.RUNNING)
        if not running:
            return
        thread = self.client.request(
            "thread/read",
            {"threadId": self.thread_id, "includeTurns": True},
            response_model=_ThreadResponse,
        ).thread
        turns = {turn.get("id"): turn for turn in thread.get("turns") or []}
        for command in running:
            turn = turns.get(command["turn_id"])
            status = (turn or {}).get("status")
            if command["kind"] == "checkpoint":
                self.ledger.update_command(command["command_id"], status="failed")
            elif status in ("completed", "failed", "interrupted"):
                for item in turn.get("items") or []:
                    self._emit_item(command["command_id"], item, completed=True)
                self._finish_turn(command["command_id"], turn)
            else:
                self._finish_unknown(command)

    def _finish_unknown(self, command: dict) -> None:
        self.ledger.update_command(command["command_id"], status="outcome_unknown")
        self.ledger.emit(
            "command.outcome_unknown", {"command_id": command["command_id"]}
        )

    # --- control requests (HTTP threads) -------------------------------------

    def accept(self, command_id: str, body: dict) -> dict:
        canonical = json.dumps(
            {k: body.get(k) for k in ("kind", "agent_sequence", "payload")},
            sort_keys=True,
        )
        command, _ = self.ledger.accept_command(
            command_id,
            agent_sequence=int(body["agent_sequence"]),
            kind=body["kind"],
            payload=body.get("payload") or {},
            request_hash=hashlib.sha256(canonical.encode()).hexdigest(),
            generation=self.settings.generation,
        )
        self._wake.set()
        return _command_view(command)

    def command_view(self, command_id: str) -> dict | None:
        command = self.ledger.get_command(command_id)
        return _command_view(command) if command else None

    def interrupt(self, command_id: str) -> dict | None:
        command = self.ledger.get_command(command_id)
        if command is None:
            return None
        if command["status"] in L.TERMINAL:
            return _command_view(command)
        self.ledger.update_command(command_id, interrupt_requested=1)
        if command["status"] == L.ACCEPTED:
            self.ledger.update_command(command_id, status="interrupted")
            self.ledger.emit(
                "turn.completed",
                {"command_id": command_id, "turn_id": None, "status": "interrupted"},
            )
        elif command["status"] == L.RUNNING:
            with self._lock:
                waiter = next(
                    (w for w in self._approvals.values() if w.command_id == command_id),
                    None,
                )
            if waiter:
                # "cancel" declines and interrupts the turn in one step.
                waiter.decision = "cancel"
                waiter.event.set()
            elif self.client and command["turn_id"]:
                threading.Thread(
                    target=self._interrupt_turn, args=(command["turn_id"],), daemon=True
                ).start()
        return self.command_view(command_id)

    def steer(self, command_id: str, body: dict) -> str:
        """Add a steer to the running command's turn.

        Returns "accepted", "not_found" or "not_running"; a steer that is not
        accepted stays queued in the control plane and runs as its own turn.
        """
        steer_id = body["command_id"]
        if steer_id in self._steers or self.ledger.get_command(steer_id):
            return "accepted"
        command = self.ledger.get_command(command_id)
        if command is None:
            return "not_found"
        client = self.client
        if (
            client is None
            or command["status"] != L.RUNNING
            or command["kind"] != "turn"
            or command["interrupt_requested"]
            or not command["turn_id"]
        ):
            return "not_running"
        text = body.get("text") or ""
        payload = {"text": text}
        canonical = json.dumps(
            {
                "kind": "turn",
                "agent_sequence": body["agent_sequence"],
                "payload": payload,
            },
            sort_keys=True,
        )
        with self._lock:
            # Registered first: Codex may echo the steer before it answers.
            self._steers[steer_id] = {
                "turn_id": command["turn_id"],
                "record": {
                    "agent_sequence": int(body["agent_sequence"]),
                    "kind": "turn",
                    "payload": payload,
                    "request_hash": hashlib.sha256(canonical.encode()).hexdigest(),
                    "generation": self.settings.generation,
                },
            }
        try:
            client.request(
                "turn/steer",
                {
                    "threadId": self.thread_id,
                    "expectedTurnId": command["turn_id"],
                    "input": [{"type": "text", "text": text}],
                    "clientUserMessageId": steer_id,
                },
                response_model=TurnSteerResponse,
            )
        except (CodexError, JsonRpcError) as exc:
            logger.info("turn/steer rejected: %s", exc)
            with self._lock:
                self._steers.pop(steer_id, None)
            return "not_running"
        return "accepted"

    def _interrupt_turn(self, turn_id: str) -> None:
        client = self.client
        if client is None:
            return  # stopping; the next instance reconciles the turn
        try:
            client.turn_interrupt(self.thread_id, turn_id)
        except Exception:
            logger.exception("turn/interrupt failed")

    def decide(self, approval_id: str, decision: str, generation: int) -> str:
        """Returns "accepted", "stale" or "not_pending"."""
        if generation != self.settings.generation:
            return "stale"
        approval = self.ledger.get_approval(approval_id)
        if approval is None:
            return "not_pending"
        if approval["status"] in ("decided", "applied"):
            return "accepted" if approval["decision"] == decision else "not_pending"
        with self._lock:
            waiter = self._approvals.get(approval_id)
        if approval["status"] != "pending" or waiter is None:
            return "not_pending"
        self.ledger.set_approval(approval_id, "decided", decision)
        waiter.decision = decision
        waiter.event.set()
        return "accepted"

    # --- SDK server requests (SDK reader thread) ------------------------------

    def _on_request(self, method: str, params: dict | None) -> dict:
        params = params or {}
        kind = APPROVAL_METHODS.get(method)
        if kind is None:
            return DECLINE_RESPONSES.get(method, {})
        command_id = self.current_command_id
        if command_id is None:
            return {"decision": "decline"}
        approval_id = str(uuid.uuid4())
        waiter = _ApprovalWaiter(command_id)
        with self._lock:
            self._approvals[approval_id] = waiter
        self.ledger.add_approval(
            approval_id, command_id, self.settings.generation, method
        )
        self.ledger.emit(
            "approval.requested",
            {
                "approval_id": approval_id,
                "command_id": command_id,
                "kind": kind,
                "summary": _approval_summary(kind, params),
            },
        )
        while not waiter.event.wait(0.5):
            if self.stopping.is_set():
                waiter.decision = "cancel"
                break
        decision = waiter.decision or "cancel"
        with self._lock:
            self._approvals.pop(approval_id, None)
        self.ledger.set_approval(approval_id, "applied", decision)
        self.ledger.emit(
            "approval.applied", {"approval_id": approval_id, "decision": decision}
        )
        return {"decision": decision}

    # --- execution ------------------------------------------------------------

    def _worker_loop(self) -> None:
        while not self.stopping.is_set():
            command = self.ledger.next_accepted()
            if command is None:
                self._wake.wait(1)
                self._wake.clear()
                continue
            if self.stopping.is_set() or self.client is None:
                return  # leave it accepted for the next instance
            self.current_command_id = command["command_id"]
            self.status = "busy"
            try:
                if command["kind"] == "checkpoint":
                    self._run_checkpoint(command)
                elif command["kind"] == "compact":
                    self._run_turn(
                        command,
                        lambda client: _start_compaction(client, self.thread_id),
                    )
                else:
                    text = command["payload"].get("text", "")
                    self._run_turn(
                        command,
                        lambda client: (
                            client.turn_start(
                                self.thread_id, [{"type": "text", "text": text}]
                            ).turn.id
                        ),
                    )
            except (TransportClosedError, RecoveryFailed):
                if self.stopping.is_set():
                    # Stopped on purpose: what ran is reconciled by the next
                    # instance from the ledger and the Codex thread.
                    return
                logger.exception("Codex transport closed")
                # A steered turn ends under the steer's command.
                latest = self.ledger.get_command(
                    self.current_command_id or command["command_id"]
                )
                if latest["status"] in (L.STARTING, L.RUNNING):
                    self._finish_unknown(latest)
                self.status = "error"
                self.error_code = "CODEX_EXITED"
                self.ledger.emit(
                    "runtime.failed", {"status": "error", "code": "CODEX_EXITED"}
                )
                return
            finally:
                self.current_command_id = None
            if self.status == "busy":
                self.status = "ready"

    def _run_turn(self, command: dict, start) -> None:
        """Start a turn with ``start(client) -> turn id`` and stream it."""
        command_id = command["command_id"]
        with self._codex_lock:
            client = self.client
            if client is None or self.stopping.is_set():
                return  # shutting down; it stays accepted
            self.ledger.update_command(command_id, status=L.STARTING)
            try:
                turn_id = start(client)
            except TransportClosedError:
                raise
            except (CodexError, JsonRpcError, TimeoutError) as exc:
                # Rejected before starting: nothing ran.
                logger.warning("%s rejected: %s", command["kind"], exc)
                self.ledger.update_command(
                    command_id, status="failed", error_code="TURN_REJECTED"
                )
                self.ledger.emit(
                    "turn.completed",
                    {"command_id": command_id, "turn_id": None, "status": "failed"},
                )
                return
            self.ledger.update_command(command_id, status=L.RUNNING, turn_id=turn_id)
        self.ledger.emit("turn.started", {"command_id": command_id, "turn_id": turn_id})
        if self.ledger.get_command(command_id)["interrupt_requested"]:
            self._interrupt_turn(turn_id)
        self._stream_turn(client, command_id, turn_id)

    def _stream_turn(self, client: CodexClient, command_id: str, turn_id: str) -> None:
        texts: dict[str, str] = {}
        dirty: set[str] = set()
        buffer_lock = threading.Lock()
        done = threading.Event()
        # The command the turn's output belongs to; a taken-in steer takes over.
        owner = command_id

        def flush():
            with buffer_lock:
                pending = [(item_id, texts[item_id]) for item_id in dirty]
                dirty.clear()
            for item_id, text in pending:
                self._emit_item(
                    owner,
                    {"id": item_id, "type": "agentMessage", "text": text},
                    completed=False,
                )

        def flusher():
            while not done.wait(FLUSH_SECONDS):
                flush()

        flusher_thread = threading.Thread(target=flusher, daemon=True)
        flusher_thread.start()
        try:
            while True:
                notification = client.next_turn_notification(turn_id)
                method = notification.method
                payload = _payload(notification)
                if method == "item/agentMessage/delta":
                    with buffer_lock:
                        item_id = payload["itemId"]
                        texts[item_id] = texts.get(item_id, "") + payload["delta"]
                        dirty.add(item_id)
                elif method in ("item/started", "item/completed"):
                    item = payload.get("item") or {}
                    if method == "item/completed" and item.get("id") in texts:
                        with buffer_lock:
                            dirty.discard(item["id"])
                    flush()
                    steer_id = item.get("clientId")
                    if item.get("type") == "userMessage" and steer_id in self._steers:
                        # Codex took the steer in: what follows answers it.
                        owner = self._take_steer(owner, steer_id, turn_id)
                    self._emit_item(owner, item, completed=method == "item/completed")
                elif method == "turn/completed":
                    flush()
                    # Steers Codex accepted but never echoed still went to
                    # this turn; never run them again.
                    for steer_id in [
                        key
                        for key, steer in list(self._steers.items())
                        if steer["turn_id"] == turn_id
                    ]:
                        owner = self._take_steer(owner, steer_id, turn_id)
                    self._finish_turn(owner, payload.get("turn") or {})
                    return
        finally:
            done.set()
            flusher_thread.join()
            client.unregister_turn_notifications(turn_id)

    def _take_steer(self, previous: str, steer_id: str, turn_id: str) -> str:
        """Hand the running turn from ``previous`` to the steer command."""
        with self._lock:
            steer = self._steers.pop(steer_id)
        self.ledger.accept_command(steer_id, **steer["record"])
        self.ledger.update_command(steer_id, status=L.RUNNING, turn_id=turn_id)
        self.ledger.update_command(previous, status="succeeded")
        self.ledger.emit(
            "turn.steered",
            {"command_id": previous, "steer_command_id": steer_id, "turn_id": turn_id},
        )
        self.current_command_id = steer_id
        return steer_id

    def _emit_item(self, command_id: str, item: dict, *, completed: bool) -> None:
        kind = ITEM_KINDS.get(item.get("type"))
        if kind is None:
            return  # user echoes, reasoning and plans are not shown
        raw_status = item.get("status")
        if raw_status in FAILED_ITEM_STATUSES:
            status = "failed"
        elif completed:
            status = "completed"
        else:
            status = "running"
        view = {"id": item.get("id"), "kind": kind, "status": status}
        if kind == "agent_message":
            view["text"] = item.get("text") or ""
        elif kind == "mcp_tool":
            view["tool"] = item.get("tool")
        self.ledger.emit("item.updated", {"command_id": command_id, "item": view})

    def _finish_turn(self, command_id: str, turn: dict) -> None:
        raw = turn.get("status")
        status = {"completed": "succeeded", "interrupted": "interrupted"}.get(
            raw, "failed"
        )
        self.ledger.update_command(
            command_id,
            status=status,
            error_code=None if status != "failed" else "TURN_FAILED",
        )
        self.ledger.emit(
            "turn.completed",
            {
                "command_id": command_id,
                "turn_id": turn.get("id"),
                "status": {"succeeded": "completed"}.get(status, status),
            },
        )

    # --- checkpoints ----------------------------------------------------------

    def _run_checkpoint(self, command: dict) -> None:
        command_id = command["command_id"]
        payload = command["payload"]
        checkpoint_id = payload["checkpoint_id"]
        self.ledger.update_command(command_id, status=L.RUNNING)
        try:
            self._wait_outbox_drained(30)
            last_seq = self.ledger.emit(
                "checkpoint.started", {"checkpoint_id": checkpoint_id}
            )
            self._wait_outbox_drained(30)
            # Pause Codex so its state files are consistent.
            self._stop_codex()
            self.ledger.update_command(command_id, status="succeeded")
            with tempfile.TemporaryDirectory() as tmp:
                archive, manifest = self._build_archive(
                    Path(tmp), checkpoint_id, last_seq
                )
                checksum = _sha256(archive)
                self.cp.transfer("PUT", payload["upload_url"], archive)
                size = archive.stat().st_size
        except Exception as exc:
            logger.exception("Checkpoint failed")
            self.ledger.update_command(
                command_id, status="failed", error_code="CHECKPOINT_FAILED"
            )
            self.ledger.emit(
                "checkpoint.failed",
                {
                    "checkpoint_id": checkpoint_id,
                    "command_id": command_id,
                    "reason": type(exc).__name__,
                },
            )
            self._resume_after_checkpoint()
            return
        self._resume_after_checkpoint()
        self.ledger.emit(
            "checkpoint.completed",
            {
                "checkpoint_id": checkpoint_id,
                "command_id": command_id,
                "checksum": checksum,
                "size": size,
                "manifest": manifest,
            },
        )

    def _resume_after_checkpoint(self) -> None:
        if self.client is None and not self.stopping.is_set():
            self._start_codex()
            self._open_thread()

    def _wait_outbox_drained(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        while not self.ledger.all_acked():
            if time.monotonic() > deadline:
                raise TimeoutError("outbox not drained")
            time.sleep(0.1)

    def _build_archive(self, tmp: Path, checkpoint_id: str, last_seq: int):
        state = tmp / "state"
        state.mkdir()
        self.ledger.backup_to(state / "runtime.sqlite3")
        home = self.settings.codex_home
        if home.exists():
            shutil.copytree(
                home,
                state / "codex",
                ignore=shutil.ignore_patterns("*.lock", "tmp"),
            )
        manifest = {
            "checkpoint_id": checkpoint_id,
            "agent_id": self.settings.agent_id,
            "thread_id": self.thread_id,
            "sdk_version": SDK_VERSION,
            "runtime_version": self.codex_version,
            "protocol_version": PROTOCOL_VERSION,
            "source_instance_id": self.settings.instance_id,
            "last_source_seq": last_seq,
            "created_at": time.time(),
            # The workspace is not copied: it lives on JuiceFS.
            "workspace": {"included": False},
            "files": sum(1 for p in state.rglob("*") if p.is_file()),
        }
        (state / "manifest.json").write_text(json.dumps(manifest))
        archive = tmp / "checkpoint.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            for path in sorted(state.iterdir()):
                tar.add(path, arcname=path.name)
        return archive, manifest

    # --- background loops ------------------------------------------------------

    def heartbeat_body(self) -> dict:
        return {
            "status": self.status,
            "error_code": self.error_code,
            "current_command_id": self.current_command_id,
            "thread_id": self.thread_id,
            "config_version": self.settings.config_version,
            "protocol_version": PROTOCOL_VERSION,
            "sdk_version": SDK_VERSION,
            "runtime_version": self.codex_version,
        }

    def _heartbeat_loop(self) -> None:
        while not self._halt.is_set():
            try:
                self.cp.heartbeat(self.heartbeat_body())
            except Fenced:
                self.fence()
            except Exception as exc:
                logger.warning("Heartbeat failed: %s", exc)
            self._halt.wait(self.settings.heartbeat_seconds)

    def _outbox_loop(self) -> None:
        backoff = 0.2
        while not self._halt.is_set():
            batch = self.ledger.unacked(limit=100, max_bytes=256 * 1024)
            if not batch:
                self._halt.wait(0.1)
                continue
            try:
                result = self.cp.post_events(batch)
                self.ledger.ack_through(int(result["acked_source_seq"]))
                backoff = 0.2
            except Fenced:
                self.fence()
            except ControlPlaneError as exc:
                expected = exc.body.get("next_expected_source_seq")
                if exc.status == 409 and isinstance(expected, int):
                    # The control plane already holds everything before this.
                    self.ledger.ack_through(expected - 1)
                    continue
                logger.warning("Event delivery rejected: %s", exc)
                self._halt.wait(backoff)
                backoff = min(backoff * 2, 5)
            except Exception as exc:
                logger.warning("Event delivery failed: %s", exc)
                self._halt.wait(backoff)
                backoff = min(backoff * 2, 5)


def _start_compaction(client: CodexClient, thread_id: str) -> str:
    """Start compacting the thread; returns the compaction turn's id.

    thread/compact/start answers before the turn exists, so its id comes from
    turn/started. Like turn/start, the SDK router buffers the thread's turn
    events meanwhile; the default consumer is attached from the first one.
    """
    router = client._router
    with client._thread_start_lock(thread_id), router.pending_turn(thread_id) as seen:
        client.thread_compact(thread_id)
        deadline = time.monotonic() + COMPACT_START_SECONDS
        with router._turn_condition:
            while True:
                if isinstance(
                    error := router._pending_turn_requests.get(thread_id),
                    BaseException,
                ):
                    raise error
                turn_id = next(
                    (
                        state.id
                        for state in router._turn_states.values()
                        if state.thread_id == thread_id and state.id not in seen
                    ),
                    None,
                )
                if turn_id:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("compaction turn never started")
                router._turn_condition.wait(remaining)
        router.prepare_turn(turn_id, thread_id, seen, for_handle=False)
    return turn_id


def _otel_overrides() -> list[str]:
    """Codex's own OpenTelemetry export, to the runtime's OTLP endpoint.

    Codex reads OTEL_RESOURCE_ATTRIBUTES from the inherited environment, so
    its records carry the agent and runtime ids; prompts are included.
    """
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").rstrip("/")

    def exporter(signal: str) -> str:
        return _toml(
            {"otlp-http": {"endpoint": f"{endpoint}/v1/{signal}", "protocol": "binary"}}
        )

    attributes = dict(
        item.split("=", 1)
        for item in os.environ.get("OTEL_RESOURCE_ATTRIBUTES", "").split(",")
        if "=" in item
    )
    environment = attributes.get("deployment.environment.name", "dev")
    return [
        f"otel.environment={_toml(environment)}",
        f"otel.log_user_prompt={_toml(True)}",
        f"otel.exporter={exporter('logs')}",
        f"otel.trace_exporter={exporter('traces')}",
        f"otel.metrics_exporter={exporter('metrics')}",
    ]


def _close_client(client: CodexClient) -> None:
    """Close the SDK client and the app-server pipes it leaves open.

    CodexClient.close() closes stdin and waits for the process, but never
    closes stdout and stderr. They are closed here once the SDK's reader
    threads have finished with them.
    """
    proc = client._proc
    readers = (client._reader_thread, client._stderr_thread)
    client.close()
    if proc is None:
        return
    if any(reader and reader.is_alive() for reader in readers):
        logger.warning("Codex output still being read; leaving its pipes open")
        return
    for stream in (proc.stdout, proc.stderr):
        if stream:
            stream.close()


def _command_view(command: dict) -> dict:
    return {
        "command_id": command["command_id"],
        "status": command["status"],
        "codex_turn_id": command["turn_id"],
        "error_code": command["error_code"],
    }


def _approval_summary(kind: str, params: dict) -> dict:
    summary = {"reason": (params.get("reason") or "")[:300] or None}
    if kind == "command":
        summary["command"] = (params.get("command") or "")[:500] or None
    return summary


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()
