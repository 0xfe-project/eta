"""The image's plugins, run the way Codex runs them."""

import json
import os
import subprocess
import sys
import threading
import tomllib
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

PLUGINS = Path(__file__).resolve().parent.parent / "plugins"
MEMORY_HOOK = PLUGINS / "memory" / "hooks" / "memory.py"
CODEX = Path(__file__).resolve().parent.parent / "codex"


class MemoryService:
    """Answers the hooks' requests like the runtime gateway and service."""

    def __init__(self):
        self.requests: list[tuple[str, dict, str]] = []
        self.memories: list[dict] = []
        service = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                service.requests.append(
                    (self.path, body, self.headers.get("Authorization"))
                )
                reply = (
                    {"memories": service.memories}
                    if self.path == "/memory/recall"
                    else {}
                )
                data = json.dumps(reply).encode()
                self.send_response(200 if self.path == "/memory/recall" else 202)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"


@pytest.fixture
def service():
    service = MemoryService()
    yield service
    service.server.shutdown()


@pytest.fixture
def hook(service, tmp_path):
    def run(mode: str, event: dict, url: str | None = None) -> dict:
        result = subprocess.run(
            [sys.executable, str(MEMORY_HOOK), mode],
            input=json.dumps(event),
            capture_output=True,
            text=True,
            check=True,
            env={
                **os.environ,
                "AXP_GATEWAY_URL": url or service.url,
                "AXP_RUNTIME_LLM_KEY": "instance.token",
                "CODEX_HOME": str(tmp_path / "codex"),
            },
        )
        return json.loads(result.stdout)

    return run


class TestMemoryHooks:
    def test_recall_adds_memories_to_the_context(self, hook, service):
        service.memories = [{"id": "m1", "text": "用户的猫叫豆豆", "score": 0.4}]
        output = hook("recall", {"turn_id": "t1", "prompt": "我的猫叫什么"})
        context = output["hookSpecificOutput"]["additionalContext"]
        assert "- 用户的猫叫豆豆 (memory m1)" in context
        assert service.requests == [
            ("/memory/recall", {"query": "我的猫叫什么"}, "Bearer instance.token")
        ]

    def test_nothing_to_recall(self, hook):
        assert hook("recall", {"turn_id": "t1", "prompt": "hi"}) == {}

    def test_capture_sends_the_turn(self, hook, service):
        hook("recall", {"turn_id": "t1", "prompt": "I like Go"})
        hook("recall", {"turn_id": "t1", "prompt": "and Rust"})
        hook(
            "capture",
            {"turn_id": "t1", "model": "gpt-x", "last_assistant_message": "Noted"},
        )
        assert service.requests[-1][:2] == (
            "/memory/capture",
            {
                "model": "gpt-x",
                "messages": [
                    {"role": "user", "content": "I like Go"},
                    {"role": "user", "content": "and Rust"},
                    {"role": "assistant", "content": "Noted"},
                ],
            },
        )
        # A turn is captured once.
        hook("capture", {"turn_id": "t1", "last_assistant_message": "again"})
        assert len(service.requests) == 3

    def test_turn_without_prompt_is_not_captured(self, hook, service):
        hook("capture", {"turn_id": "compaction", "last_assistant_message": "x"})
        assert service.requests == []

    def test_unreachable_service_never_fails_the_turn(self, hook):
        output = hook(
            "recall", {"turn_id": "t2", "prompt": "hi"}, url="http://127.0.0.1:9"
        )
        assert output == {}


class TestCodexConfig:
    """The static Codex configuration (codex/) matches the plugins."""

    def test_every_plugin_tool_is_approved(self):
        config = tomllib.loads((CODEX / "config.toml").read_text())
        catalog = json.loads((PLUGINS / ".agents/plugins/marketplace.json").read_text())
        for plugin in catalog["plugins"]:
            mcp = PLUGINS / plugin["source"]["path"] / ".mcp.json"
            if not mcp.exists():
                continue
            plugin_id = f"{plugin['name']}@{catalog['name']}"
            for server in json.loads(mcp.read_text())["mcpServers"]:
                settings = config["plugins"][plugin_id]["mcp_servers"][server]
                assert settings["default_tools_approval_mode"] == "approve"

    def test_hooks_run_scripts_of_the_image(self):
        requirements = tomllib.loads((CODEX / "requirements.toml").read_text())
        assert requirements["allow_managed_hooks_only"]
        for groups in requirements["hooks"].values():
            for group in groups:
                for hook in group["hooks"]:
                    script = hook["command"].split()[1]
                    image_path = Path(script).relative_to("/opt/axp/plugins")
                    assert (PLUGINS / image_path).is_file()
