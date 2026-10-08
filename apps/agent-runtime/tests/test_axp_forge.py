"""bin/axp-forge: git's credential helper and the gh wrapper."""

import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

AXP_FORGE = Path(__file__).resolve().parents[1] / "bin" / "axp-forge"


class Forge:
    """Answers like the forge service behind the runtime gateway."""

    def __init__(self):
        self.requests: list[tuple[str, dict | None, str]] = []
        self.connected = True
        forge = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _answer(self, body):
                forge.requests.append((self.path, body, self.headers["Authorization"]))
                if not forge.connected:
                    status, reply = (
                        409,
                        {
                            "error": {
                                "code": "GITHUB_NOT_CONNECTED",
                                "message": "GitHub 还没有连接。",
                            }
                        },
                    )
                elif self.path == "/forge/credential":
                    status, reply = (
                        200,
                        {
                            "username": "x-access-token",
                            "password": "ghs_push",
                            "expires_at": 4102444800,
                        },
                    )
                elif self.path == "/forge/gh-token":
                    status, reply = (
                        200,
                        {
                            "token": f"ghs_read_{body['owner']}",
                            "expires_at": 4102444800,
                        },
                    )
                elif self.path == "/forge/identity":
                    status, reply = (
                        200,
                        {
                            "name": "axp[bot]",
                            "email": "1+axp[bot]@users.noreply.github.com",
                        },
                    )
                else:
                    status, reply = 404, {}
                data = json.dumps(reply).encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self._answer(None)

            def do_POST(self):
                self._answer(
                    json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                )

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def paths(self):
        return [path for path, _, _ in self.requests]


@pytest.fixture
def forge():
    forge = Forge()
    yield forge
    forge.server.shutdown()


@pytest.fixture
def env(forge, tmp_path):
    run = tmp_path / "run"
    run.mkdir()
    (run / "gateway.json").write_text(json.dumps({"url": forge.url, "key": "inst.key"}))
    # The real gh, replaced by one that shows what it was given.
    fake_gh = tmp_path / "real-gh"
    fake_gh.write_text('#!/bin/sh\necho "token=${GH_TOKEN:-none} args=$*"\n')
    fake_gh.chmod(0o755)
    wrapper = tmp_path / "bin" / "gh"
    wrapper.parent.mkdir()
    wrapper.symlink_to(AXP_FORGE)
    return {
        **os.environ,
        "AXP_RUN_DIR": str(run),
        "AXP_REAL_GH": str(fake_gh),
        "PATH": f"{wrapper.parent}:{os.environ['PATH']}",
    }


def credential(env, request: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [str(AXP_FORGE), "git-credential", "get"],
        input=request,
        capture_output=True,
        text=True,
        env=env,
    )


class TestGitCredential:
    def test_a_token_for_the_repository(self, forge, env, tmp_path):
        done = credential(
            env, "protocol=https\nhost=github.com\npath=akarachen/axp.git\n"
        )
        assert done.stdout.splitlines() == [
            "username=x-access-token",
            "password=ghs_push",
            "password_expiry_utc=4102444800",
        ]
        path, body, auth = forge.requests[0]
        assert (path, body, auth) == (
            "/forge/credential",
            {"host": "github.com", "path": "akarachen/axp.git"},
            "Bearer inst.key",
        )
        include = tmp_path / "run" / "git" / "github.inc"
        assert "name = axp[bot]" in include.read_text()

    def test_other_hosts_are_left_alone(self, forge, env):
        done = credential(env, "protocol=https\nhost=gitlab.com\npath=a/b.git\n")
        assert done.stdout == ""
        assert forge.requests == []

    def test_not_connected(self, forge, env):
        forge.connected = False
        done = credential(env, "protocol=https\nhost=github.com\npath=a/b.git\n")
        assert done.returncode == 0
        assert done.stdout == ""
        assert "GitHub 还没有连接" in done.stderr


def gh(env, *args, cwd=None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["gh", *args], capture_output=True, text=True, env=env, cwd=cwd
    )


class TestGh:
    def test_owner_from_the_repo_flag_and_a_cached_token(self, forge, env):
        assert gh(env, "pr", "view", "3", "-R", "acme/web").stdout.strip() == (
            "token=ghs_read_acme args=pr view 3 -R acme/web"
        )
        gh(env, "pr", "list", "--repo=https://github.com/acme/web")
        assert forge.paths().count("/forge/gh-token") == 1

    @pytest.mark.parametrize(
        ("args", "owner"),
        [
            (["repo", "view", "octo/hello"], "octo"),
            (["api", "repos/octo/hello/pulls"], "octo"),
        ],
    )
    def test_owner_from_the_command(self, forge, env, args, owner):
        assert f"token=ghs_read_{owner}" in gh(env, *args).stdout

    def test_owner_from_the_origin_remote(self, forge, env, tmp_path):
        repo = tmp_path / "repo"
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(repo),
                "remote",
                "add",
                "origin",
                "git@github.com:me/proj.git",
            ],
            check=True,
        )
        assert "token=ghs_read_me" in gh(env, "pr", "list", cwd=repo).stdout

    def test_not_connected_runs_anonymously(self, forge, env):
        forge.connected = False
        done = gh(env, "repo", "view", "octo/hello")
        assert "token=none" in done.stdout
        assert "gh 将以匿名身份运行" in done.stderr

    def test_a_token_given_by_the_user_wins(self, forge, env):
        done = gh({**env, "GH_TOKEN": "mine"}, "repo", "view", "octo/hello")
        assert "token=mine" in done.stdout
        assert forge.requests == []
