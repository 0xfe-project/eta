"""The image's plugins, run the way Codex runs them."""

import json
import os
import shutil
import subprocess
import sys
import threading
import tomllib
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from axp_runtime import plugins

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


class TestBuild:
    """Building the image's plugins (axp_runtime/plugins.py)."""

    @pytest.fixture
    def built(self, tmp_path):
        root = tmp_path / "plugins"
        shutil.copytree(PLUGINS, root)
        codex = tmp_path / "codex"
        shutil.copytree(CODEX, codex)
        # Setup scripts install system-wide; only the generated files here.
        plugins.write_marketplace(root)
        for name, tables in (
            ("config.toml", plugins.tool_approvals(root)),
            ("requirements.toml", plugins.managed_hooks(root)),
        ):
            with (codex / name).open("a") as file:
                file.write(tables)
        return root, codex

    def test_marketplace_lists_every_plugin(self, built):
        root, _ = built
        catalog = json.loads((root / ".agents/plugins/marketplace.json").read_text())
        assert catalog["name"] == "axp"
        assert [p["name"] for p in catalog["plugins"]] == ["grok", "memory", "tasks"]
        for plugin in catalog["plugins"]:
            assert (root / plugin["source"]["path"] / ".codex-plugin").is_dir()

    def test_every_plugin_tool_is_approved(self, built):
        _, codex = built
        config = tomllib.loads((codex / "config.toml").read_text())
        assert config["sandbox_mode"] == "danger-full-access"
        servers = {
            plugin: list(settings["mcp_servers"])
            for plugin, settings in config["plugins"].items()
        }
        assert servers == {
            "grok@axp": ["grok"],
            "memory@axp": ["memory"],
            "tasks@axp": ["tasks"],
        }
        for settings in config["plugins"].values():
            for server in settings["mcp_servers"].values():
                assert server == {"default_tools_approval_mode": "approve"}

    def test_hooks_become_managed_and_run_from_the_image(self, built):
        _, codex = built
        requirements = tomllib.loads((codex / "requirements.toml").read_text())
        assert requirements["allow_managed_hooks_only"]
        [[recall]] = [g["hooks"] for g in requirements["hooks"]["UserPromptSubmit"]]
        assert recall["timeout"] == 5
        assert (
            "python /opt/axp/plugins/memory/hooks/memory.py recall"
            in (recall["command"])
        )
        assert set(requirements["hooks"]) == {"UserPromptSubmit", "Stop"}

    def test_hooks_run_only_where_their_plugin_is_installed(self, built, tmp_path):
        _, codex = built
        requirements = tomllib.loads((codex / "requirements.toml").read_text())
        command = requirements["hooks"]["Stop"][0]["hooks"][0]["command"]
        command = command.replace("python /opt/axp/plugins", "echo ran")
        home = tmp_path / "home"

        def run():
            env = {**os.environ, "CODEX_HOME": str(home)}
            return subprocess.run(
                ["sh", "-c", command], env=env, capture_output=True, text=True
            )

        assert (run().returncode, run().stdout) == (0, "")
        (home / "plugins/cache/axp/memory/1.0.0").mkdir(parents=True)
        assert run().stdout == "ran/memory/hooks/memory.py capture\n"

    def test_setup_scripts_are_executable(self):
        for plugin in plugins.plugins(PLUGINS):
            script = plugin / "setup"
            if script.exists():
                assert os.access(script, os.X_OK), script

    def test_setup_runs_from_the_plugin_with_its_cache(self, tmp_path):
        root = tmp_path / "plugins"
        plugin = root / "demo"
        (plugin / ".codex-plugin").mkdir(parents=True)
        (plugin / ".codex-plugin/plugin.json").write_text('{"name": "demo"}')
        (plugin / "setup").write_text(
            '#!/bin/sh\necho "$PWD $PLUGIN_ROOT" > "$AXP_PLUGIN_CACHE/ran"\n'
        )
        (plugin / "setup").chmod(0o755)
        plugins.setup(root, tmp_path / "cache")
        assert (tmp_path / "cache/demo/ran").read_text() == f"{plugin} {plugin}\n"

    def test_failed_setup_fails_the_build(self, tmp_path):
        root = tmp_path / "plugins"
        plugin = root / "demo"
        (plugin / ".codex-plugin").mkdir(parents=True)
        (plugin / ".codex-plugin/plugin.json").write_text('{"name": "demo"}')
        (plugin / "setup").write_text("#!/bin/sh\nexit 3\n")
        (plugin / "setup").chmod(0o755)
        with pytest.raises(subprocess.CalledProcessError):
            plugins.setup(root, tmp_path / "cache")
