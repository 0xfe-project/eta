"""The image's akhook rules (hooks/akhook.yml) and the approval plugin."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

HOOKS = Path(__file__).resolve().parents[1] / "hooks"
REPO = Path(__file__).resolve().parents[3]
PLUGINS = HOOKS.parent / "plugins"


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """Where the commands run."""
    path = tmp_path / "repo"
    path.mkdir()
    return path


def _akhook() -> str | None:
    built = REPO / "vendor/akhook/target/release/akhook"
    return (
        os.environ.get("AKHOOK")
        or shutil.which("akhook")
        or (str(built) if built.exists() else None)
    )


@pytest.mark.skipif(_akhook() is None, reason="akhook is not built")
class TestRules:
    """The rules as the image runs them."""

    def run(self, command: str, cwd: Path, tmp_path: Path) -> dict | None:
        event = {
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": command},
            "cwd": str(cwd),
        }
        done = subprocess.run(
            [_akhook(), "codex", "hook", "pre_tool_use"],
            input=json.dumps(event),
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "HOME": str(tmp_path),
                "XDG_CONFIG_HOME": str(tmp_path / "config"),
                "AKHOOK_ADDITIONAL_CONFIG_PATH": str(HOOKS / "akhook.yml"),
                "AKHOOK_STATE_DIR": str(tmp_path / "state"),
            },
            check=True,
        )
        if not done.stdout.strip():
            return None
        return json.loads(done.stdout)["hookSpecificOutput"]

    @pytest.mark.parametrize(
        "command",
        [
            "git push origin main",
            "gh issue create -t x -b y",
            "gh api -X DELETE repos/a/b",
        ],
    )
    def test_github_commands_pass(self, repo, tmp_path, command):
        assert self.run(command, repo, tmp_path) is None

    @pytest.mark.parametrize(
        ("command", "rule"),
        [
            ("gh pr create --fill", "gh-pr-create"),
            ("cd x && gh -R a/b pr create", "gh-pr-create"),
            ("akhook approval grant 0123456789abcdef", "akhook-approval"),
        ],
    )
    def test_denied(self, repo, tmp_path, command, rule):
        decision = self.run(command, repo, tmp_path)
        assert decision["permissionDecision"] == "deny"
        assert f"[{rule}]" in decision["permissionDecisionReason"]


@pytest.mark.skipif(_akhook() is None, reason="akhook is not built")
class TestApprovalPlugin:
    """request_approval asks through MCP elicitation, then grants the request."""

    @pytest.fixture
    def server(self, monkeypatch, tmp_path):
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "approval_server", PLUGINS / "approval" / "server.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        monkeypatch.setattr(module, "AKHOOK", _akhook())
        monkeypatch.setenv("AKHOOK_STATE_DIR", str(tmp_path / "state"))
        return module

    def _call(self, server, request_id: str, action: str) -> tuple[str, list]:
        import anyio
        from mcp import types
        from mcp.shared.memory import create_connected_server_and_client_session

        asked = []

        async def answer(context, params):
            asked.append(params)
            return types.ElicitResult(
                action=action, content={} if action == "accept" else None
            )

        async def call():
            async with create_connected_server_and_client_session(
                server.mcp, elicitation_callback=answer
            ) as client:
                result = await client.call_tool(
                    "request_approval", {"request_id": request_id}
                )
                return result.content[0].text

        return anyio.run(call), asked

    def _blocked(self, repo, tmp_path) -> str:
        config = tmp_path / "ask.yml"
        config.write_text(
            "version: 1\nask_instruction: 'id={request_id}'\nrules:\n"
            "  - id: push\n    on: shell_exec\n    action: ask\n"
            "    checks: [{argv: [git, push]}]\n    message: 要推送。\n"
        )
        self.env = {
            **os.environ,
            "AKHOOK_ADDITIONAL_CONFIG_PATH": str(config),
            "AKHOOK_STATE_DIR": str(tmp_path / "state"),
            "XDG_CONFIG_HOME": str(tmp_path / "config"),
        }
        self.event = json.dumps(
            {
                "hook_event_name": "PreToolUse",
                "tool_name": "Bash",
                "tool_input": {"command": "git push origin main"},
                "cwd": str(repo),
            }
        )
        reason = self._hook()["permissionDecisionReason"]
        return reason.split("id=")[1][:16]

    def _hook(self) -> dict | None:
        done = subprocess.run(
            [_akhook(), "codex", "hook", "pre_tool_use"],
            input=self.event,
            capture_output=True,
            text=True,
            env=self.env,
            check=True,
        )
        return (
            json.loads(done.stdout)["hookSpecificOutput"]
            if done.stdout.strip()
            else None
        )

    def test_accepting_lets_the_command_through_once(self, server, repo, tmp_path):
        request_id = self._blocked(repo, tmp_path)
        text, asked = self._call(server, request_id, "accept")
        assert "用户同意了" in text
        assert asked[0].message == "要推送。\n\ngit push origin main"
        assert asked[0].requestedSchema == {"type": "object", "properties": {}}
        assert self._hook() is None
        assert self._hook() is not None

    def test_declining_keeps_it_blocked(self, server, repo, tmp_path):
        request_id = self._blocked(repo, tmp_path)
        text, _ = self._call(server, request_id, "decline")
        assert "用户拒绝了" in text
        assert self._hook() is not None
