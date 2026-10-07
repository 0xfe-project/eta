"""Control plane -> runtime calls (RFC §6)."""

import json
import urllib.error
import urllib.request

from .auth import runtime_token


class RuntimeUnavailable(Exception):
    pass


class RuntimeHttpError(Exception):
    def __init__(self, status: int, code: str | None):
        super().__init__(f"runtime returned {status} {code}")
        self.status = status
        self.code = code


class RuntimeClient:
    def __init__(self, instance, timeout: float = 5.0):
        self.instance = instance
        self.base = f"{instance.endpoint}/internal/v1"
        self.token = runtime_token(instance.id, instance.generation)
        self.timeout = timeout

    def _call(self, method: str, path: str, body: dict | None = None) -> dict:
        request = urllib.request.Request(
            self.base + path,
            data=json.dumps(body).encode() if body is not None else None,
            method=method,
        )
        request.add_header("Authorization", f"Bearer {self.token}")
        request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as exc:
            try:
                code = json.loads(exc.read() or b"{}").get("error", {}).get("code")
            except ValueError:
                code = None
            raise RuntimeHttpError(exc.code, code) from exc
        except (urllib.error.URLError, OSError) as exc:
            raise RuntimeUnavailable(str(exc)) from exc

    def status(self) -> dict:
        return self._call("GET", "/status")

    def put_command(self, command) -> dict:
        return self._call(
            "PUT",
            f"/commands/{command.id}",
            {
                "kind": command.kind,
                "agent_id": str(command.agent_id),
                "generation": self.instance.generation,
                "agent_sequence": command.agent_sequence,
                "payload": command.input,
            },
        )

    def interrupt(self, command_id) -> dict | None:
        try:
            return self._call(
                "POST",
                f"/commands/{command_id}/interrupt",
                {"generation": self.instance.generation},
            )
        except RuntimeHttpError as exc:
            if exc.status == 404:
                return None
            raise

    def steer(self, target, command) -> None:
        """Add a steer command to the turn running ``target``."""
        self._call(
            "POST",
            f"/commands/{target.id}/steer",
            {
                "generation": self.instance.generation,
                "command_id": str(command.id),
                "agent_sequence": command.agent_sequence,
                "text": command.input["text"],
            },
        )

    def decide(self, approval) -> None:
        self._call(
            "PUT",
            f"/approvals/{approval.sdk_request_id}/decision",
            {"decision": approval.decision, "generation": approval.generation},
        )
