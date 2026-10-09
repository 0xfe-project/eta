"""Client for the control plane's internal runtime endpoints."""

import json
import urllib.error
import urllib.request

from .config import Settings
from .ledger import encode


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
            f"{settings.gateway_url}/internal/v1/runtime-instances/"
            f"{settings.instance_id}"
        )

    def _request(self, method: str, url: str, body: dict | None = None) -> dict:
        data = encode(body) if body is not None else None
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

    def snapshot_upload_url(self) -> str:
        return self._request("POST", f"{self.base}/snapshot")["upload_url"]


def upload(url: str, path) -> None:
    """PUT a file to a presigned URL."""
    with open(path, "rb") as handle:
        request = urllib.request.Request(url, data=handle, method="PUT")
        request.add_header("Content-Length", str(path.stat().st_size))
        with urllib.request.urlopen(request, timeout=300):
            pass


def download(url: str, path) -> None:
    """GET a presigned URL into a file."""
    with urllib.request.urlopen(url, timeout=300) as response:
        with open(path, "wb") as handle:
            while chunk := response.read(1 << 20):
                handle.write(chunk)
