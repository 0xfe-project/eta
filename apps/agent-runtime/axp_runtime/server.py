"""Internal HTTP endpoints called by the control plane (RFC §6)."""

import hmac
import json
import logging
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from openai_codex import __version__ as SDK_VERSION

from .config import PROTOCOL_VERSION
from .ledger import CommandConflict
from .runtime import Runtime

logger = logging.getLogger(__name__)

COMMAND = re.compile(r"^/internal/v1/commands/([\w-]+)$")
INTERRUPT = re.compile(r"^/internal/v1/commands/([\w-]+)/interrupt$")
DECISION = re.compile(r"^/internal/v1/approvals/([\w-]+)/decision$")
DECISIONS = {"accept", "decline"}


def make_handler(runtime: Runtime):
    settings = runtime.settings

    class Handler(BaseHTTPRequestHandler):
        server_version = "axp-runtime"

        def log_message(self, fmt, *args):
            logger.debug(fmt, *args)

        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _error(self, status: int, code: str) -> None:
            self._send(status, {"error": {"code": code}})

        def _token_ok(self) -> bool:
            header = self.headers.get("Authorization", "")
            expected = f"Bearer {settings.token}"
            if hmac.compare_digest(header.encode(), expected.encode()):
                return True
            self._error(403, "INVALID_TOKEN")
            return False

        def _body(self) -> dict | None:
            length = int(self.headers.get("Content-Length") or 0)
            try:
                return json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                self._error(400, "BAD_REQUEST")
                return None

        def _generation_ok(self, body: dict) -> bool:
            if body.get("generation") != settings.generation:
                self._error(409, "STALE_GENERATION")
                return False
            return True

        def do_GET(self):
            if not self._token_ok():
                return
            if self.path == "/internal/v1/status":
                return self._send(
                    200,
                    {
                        "status": runtime.status,
                        "error_code": runtime.error_code,
                        "agent_id": settings.agent_id,
                        "instance_id": settings.instance_id,
                        "generation": settings.generation,
                        "thread_id": runtime.thread_id,
                        "current_command_id": runtime.current_command_id,
                        "protocol_version": PROTOCOL_VERSION,
                        "sdk_version": SDK_VERSION,
                        "runtime_version": runtime.codex_version,
                    },
                )
            if match := COMMAND.match(self.path):
                if runtime.ledger is None:
                    return self._error(503, "NOT_READY")
                view = runtime.command_view(match.group(1))
                return self._send(200, view) if view else self._error(404, "NOT_FOUND")
            self._error(404, "NOT_FOUND")

        def do_PUT(self):
            if not self._token_ok() or (body := self._body()) is None:
                return
            if match := COMMAND.match(self.path):
                if not self._generation_ok(body):
                    return
                if body.get("agent_id") != settings.agent_id:
                    return self._error(409, "AGENT_MISMATCH")
                if runtime.status not in ("ready", "busy"):
                    return self._error(503, "NOT_READY")
                if body.get("kind") not in ("turn", "checkpoint"):
                    return self._error(400, "BAD_REQUEST")
                try:
                    view = runtime.accept(match.group(1), body)
                except CommandConflict:
                    return self._error(409, "COMMAND_CONFLICT")
                return self._send(202, view)
            if match := DECISION.match(self.path):
                if body.get("decision") not in DECISIONS:
                    return self._error(400, "BAD_REQUEST")
                result = runtime.decide(
                    match.group(1), body["decision"], body.get("generation")
                )
                if result == "stale":
                    return self._error(409, "STALE_GENERATION")
                if result == "not_pending":
                    return self._error(409, "APPROVAL_NOT_PENDING")
                return self._send(202, {"approval_id": match.group(1)})
            self._error(404, "NOT_FOUND")

        def do_POST(self):
            if not self._token_ok() or (body := self._body()) is None:
                return
            if match := INTERRUPT.match(self.path):
                if not self._generation_ok(body):
                    return
                if runtime.ledger is None:
                    return self._error(503, "NOT_READY")
                view = runtime.interrupt(match.group(1))
                return self._send(202, view) if view else self._error(404, "NOT_FOUND")
            self._error(404, "NOT_FOUND")

    return Handler


def serve(runtime: Runtime) -> ThreadingHTTPServer:
    settings = runtime.settings
    server = ThreadingHTTPServer(
        (settings.listen_host, settings.listen_port), make_handler(runtime)
    )
    server.daemon_threads = True
    return server
