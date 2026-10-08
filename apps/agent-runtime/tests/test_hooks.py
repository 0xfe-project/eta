"""The image's akhook rules (hooks/akhook.yml) and their push-target script."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

HOOKS = Path(__file__).resolve().parents[1] / "hooks"
REPO = Path(__file__).resolve().parents[3]
PUSH_TARGET = HOOKS / "push-target"
PLUGINS = HOOKS.parent / "plugins"


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A clone of a remote whose default branch is `trunk`, on `feature`."""
    path = tmp_path / "repo"
    path.mkdir()
    _git(path, "init", "-q", "-b", "feature")
    _git(path, "remote", "add", "origin", "https://example.invalid/repo.git")
    _git(path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
    return path


def _decide(command: str, cwd: Path) -> dict:
    done = subprocess.run(
        [str(PUSH_TARGET)],
        input=json.dumps({"candidate": {"type": "shell_exec", "command": command}}),
        capture_output=True,
        text=True,
        cwd=cwd,
        check=True,
    )
    return json.loads(done.stdout)


class TestPushTarget:
    @pytest.mark.parametrize(
        "command",
        [
            "git push",
            "git push origin feature",
            "git push -u origin HEAD",
            "git push origin feature:review/feature",
            "git push --tags",
            "git push origin refs/tags/v1",
            "git status && echo git push main",
        ],
    )
    def test_other_branches_are_allowed(self, repo, command):
        assert _decide(command, repo) == {"action": "allow"}

    @pytest.mark.parametrize(
        ("command", "branch"),
        [
            ("git push origin main", "main"),
            ("git push origin HEAD:master", "master"),
            ("git push origin feature:refs/heads/trunk", "trunk"),
            ("git push --force origin +main", "main"),
            ("git push origin --delete main", "main"),
            ("git push origin :trunk", "trunk"),
            ("cd . && FOO=1 git -C . push origin main", "main"),
            ("git push --all origin", "所有分支"),
        ],
    )
    def test_protected_branches_ask(self, repo, command, branch):
        answer = _decide(command, repo)
        assert answer["action"] == "ask"
        assert branch in answer["message"]

    def test_a_bare_push_from_the_default_branch_asks(self, repo):
        _git(repo, "checkout", "-q", "-b", "trunk")
        assert _decide("git push", repo)["action"] == "ask"

    def test_a_bare_push_follows_the_upstream(self, repo):
        _git(repo, "config", "branch.feature.remote", "origin")
        _git(repo, "config", "branch.feature.merge", "refs/heads/main")
        _git(repo, "config", "push.default", "upstream")
        _git(repo, "update-ref", "refs/remotes/origin/main", _head(repo))
        assert _decide("git push", repo)["action"] == "ask"

    def test_unreadable_commands_ask(self, repo):
        assert _decide("git push 'origin", repo)["action"] == "ask"


def _head(repo: Path) -> str:
    _git(repo, "commit", "-q", "--allow-empty", "-m", "x")
    return subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def _akhook() -> str | None:
    built = REPO / "vendor/akhook/target/release/akhook"
    return (
        os.environ.get("AKHOOK")
        or shutil.which("akhook")
        or (str(built) if built.exists() else None)
    )


@pytest.mark.skipif(_akhook() is None, reason="akhook is not built")
class TestRules:
    """The rules as the image runs them, with push-target at its image path
    replaced by the one in this checkout."""

    @pytest.fixture
    def run(self, repo, tmp_path):
        config = tmp_path / "akhook.yml"
        config.write_text(
            (HOOKS / "akhook.yml")
            .read_text()
            .replace("/etc/akhook/push-target", str(PUSH_TARGET))
        )
        env = {
            **os.environ,
            "HOME": str(tmp_path),
            "XDG_CONFIG_HOME": str(tmp_path / "config"),
            "AKHOOK_ADDITIONAL_CONFIG_PATH": str(config),
            "AKHOOK_STATE_DIR": str(tmp_path / "state"),
        }

        def run(command: str, *args: str) -> dict | None:
            event = {
                "hook_event_name": "PreToolUse",
                "tool_name": "Bash",
                "tool_input": {"command": command},
                "cwd": str(repo),
            }
            done = subprocess.run(
                [_akhook(), *args]
                if args
                else [_akhook(), "codex", "hook", "pre_tool_use"],
                input=json.dumps(event),
                capture_output=True,
                text=True,
                env=env,
                check=True,
            )
            if not done.stdout.strip():
                return None
            return json.loads(done.stdout)["hookSpecificOutput"]

        run.env = env
        return run

    @pytest.mark.parametrize(
        "command",
        [
            "git push origin feature",
            "gh pr view 3",
            "gh pr list",
            "gh api repos/a/b/pulls",
            "gh api graphql -f query='{ viewer { login } }'",
            "git log",
        ],
    )
    def test_reads_and_ordinary_pushes_pass(self, run, command):
        assert run(command) is None

    @pytest.mark.parametrize(
        ("command", "rule"),
        [
            ("gh pr create --fill", "gh-pr-create"),
            ("cd x && gh -R a/b pr create", "gh-pr-create"),
            ("gh pr merge 3 --squash", "gh-write"),
            ("gh issue comment 3 -b hi", "gh-write"),
            ("gh repo create a/b", "gh-write"),
            ("gh api -X DELETE repos/a/b", "gh-write"),
            ("gh api graphql -f query='mutation { x }'", "gh-write"),
            ("akhook approval grant 0123456789abcdef", "akhook-approval"),
        ],
    )
    def test_writes_are_denied(self, run, command, rule):
        decision = run(command)
        assert decision["permissionDecision"] == "deny"
        assert f"[{rule}]" in decision["permissionDecisionReason"]

    def test_pushing_main_needs_the_users_approval_once(self, run):
        decision = run("git push origin main")
        reason = decision["permissionDecisionReason"]
        assert "要推送到受保护分支：main" in reason
        request_id = reason.split("request_id 为 ")[1][:16]
        subprocess.run(
            [_akhook(), "approval", "grant", request_id], env=run.env, check=True
        )
        assert run("git push origin main") is None
        assert run("git push origin main") is not None


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
