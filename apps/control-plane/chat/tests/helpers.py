import json
import uuid

from django.test import Client

# Fields that must never reach the browser (RFC §10).
INTERNAL_MARKERS = (
    "command",
    "thread",
    "runtime",
    "generation",
    "lease",
    "claim",
    "container",
    "conversation",
    "agent_sequence",
    "seq",
    "product_status",
    "deleted_at",
)


class ChatClient:
    """Thin wrapper that adds Idempotency-Key and JSON handling."""

    def __init__(self):
        self.client = Client()

    def get(self, path, **kwargs):
        return self.client.get(f"/api/v1{path}", **kwargs)

    def post(self, path, body=None, key: str | None = "auto", **headers):
        if key == "auto":
            key = str(uuid.uuid4())
        if key is not None:
            headers["HTTP_IDEMPOTENCY_KEY"] = key
        return self.client.post(
            f"/api/v1{path}",
            data=json.dumps(body) if body is not None else "",
            content_type="application/json",
            **headers,
        )

    def patch(self, path, body):
        return self.client.patch(
            f"/api/v1{path}", data=json.dumps(body), content_type="application/json"
        )

    def delete(self, path):
        return self.client.delete(f"/api/v1{path}")

    def create_agent(self, name="开发助手"):
        response = self.post("/agents", {"name": name})
        assert response.status_code == 201, response.content
        return response.json()

    def send(self, agent_id, text="检查项目结构"):
        response = self.post("/chat/messages", {"agent_id": agent_id, "text": text})
        assert response.status_code == 202, response.content
        return response.json()


def collect_keys(value, keys=None):
    keys = set() if keys is None else keys
    if isinstance(value, dict):
        for key, item in value.items():
            keys.add(key)
            collect_keys(item, keys)
    elif isinstance(value, list):
        for item in value:
            collect_keys(item, keys)
    return keys


def assert_no_internal_fields(payload):
    leaked = {k for k in collect_keys(payload) for m in INTERNAL_MARKERS if m in k}
    assert not leaked, f"internal fields leaked: {leaked}"


def error_of(response):
    """(status, error code) of an error envelope, for one-line assertions."""
    return response.status_code, response.json()["error"]["code"]
