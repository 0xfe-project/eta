"""The image's akhook rules (hooks/akhook.yml)."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

HOOKS = Path(__file__).resolve().parents[1] / "hooks"
REPO = Path(__file__).resolve().parents[3]


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

    @pytest.fixture
    def run(self, repo, tmp_path):
        config = HOOKS / "akhook.yml"
        env = {
            **os.environ,
            "HOME": str(tmp_path),
            "XDG_CONFIG_HOME": str(tmp_path / "config"),
            "AKHOOK_ADDITIONAL_CONFIG_PATH": str(config),
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
        ],
    )
    def test_writes_are_denied(self, run, command, rule):
        decision = run(command)
        assert decision["permissionDecision"] == "deny"
        assert f"[{rule}]" in decision["permissionDecisionReason"]
