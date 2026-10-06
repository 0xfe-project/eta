"""Client for the control plane's internal runtime endpoints."""

import json
import urllib.error
import urllib.request

from .config import Settings


class Fenced(Exception):
    """The control plane no longer accepts this runtime instance."""


class ControlPlaneError(Exception):
    def __init__(self, status: int, body: dict):
        super().__init__(f"control plane returned {status}: {body}")
        self.status = status
        self.body = body


class ControlPlane:
    def __init__(self, settings: Settings, timeout: float = 10.0):
        self.settings = settings
        self.timeout = timeout
        self.base = (
            f"{settings.control_plane_url}/internal/v1/runtime-instances/"
            f"{settings.instance_id}"
        )

    def _request(self, method: str, url: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("Authorization", f"Bearer {self.settings.token}")
        request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            try:
                payload = json.loads(exc.read() or b"{}")
            except ValueError:
                payload = {}
            code = (payload.get("error") or {}).get("code")
            if code in ("STALE_GENERATION", "INVALID_RUNTIME_TOKEN"):
                raise Fenced(code) from exc
            raise ControlPlaneError(exc.code, payload) from exc

    def heartbeat(self, body: dict) -> dict:
        return self._request("POST", f"{self.base}/heartbeat", body)

    def register_session(self, body: dict) -> dict:
        return self._request("PUT", f"{self.base}/session", body)

    def post_events(self, events: list[dict]) -> dict:
        return self._request("POST", f"{self.base}/events", {"events": events})

    def transfer(self, method: str, url: str, path, headers: dict | None = None):
        """Upload a file to, or download it from, a checkpoint object URL."""
        if method == "PUT":
            with open(path, "rb") as handle:
                data = handle.read()
        else:
            data = None
        request = urllib.request.Request(url, data=data, method=method)
        for name, value in (headers or {}).items():
            request.add_header(name, value)
        if url.startswith(self.settings.control_plane_url):
            request.add_header("Authorization", f"Bearer {self.settings.token}")
        with urllib.request.urlopen(request, timeout=300) as response:
            if method == "GET":
                with open(path, "wb") as handle:
                    while chunk := response.read(1 << 20):
                        handle.write(chunk)
