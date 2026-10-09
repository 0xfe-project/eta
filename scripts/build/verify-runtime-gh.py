"""Offline smoke check inside a disposable runtime container.

Run: docker run --rm -i --entrypoint python <image> < scripts/build/verify-runtime-gh.py
Uses only synthetic credentials; command output is captured, never logged.
"""

import json
import os
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

from axp_runtime.runtime import Runtime


def command(*args, input=None):
    result = subprocess.run(args, input=input, text=True, capture_output=True)
    assert result.returncode == 0, f"{args[0]} command failed (output withheld)"
    return result.stdout


for variable in ("GH_TOKEN", "GITHUB_TOKEN", "GH_DEBUG"):
    os.environ.pop(variable, None)
os.environ["GIT_TERMINAL_PROMPT"] = "0"
assert os.environ["GH_CONFIG_DIR"] == "/run/axp/gh"
print(command("gh", "--version").strip())
command("gh", "pr", "create", "--help")
command("gh", "api", "--help")

answer = {
    "token": "ghs_synthetic_first",
    "expires_at": int(time.time()) + 3600,
    "identity": {"name": "axp[bot]", "email": "1+axp[bot]@users.noreply.github.com"},
}
connected = True


class Forge(BaseHTTPRequestHandler):
    def do_GET(self):
        assert self.path == "/forge/credentials"
        assert self.headers["Authorization"] == "Bearer smoke.synthetic"
        self.send_response(200 if connected else 409)
        self.end_headers()
        self.wfile.write(json.dumps(answer if connected else {}).encode())

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Forge)
threading.Thread(target=server.serve_forever, daemon=True).start()
runtime = Runtime.__new__(Runtime)
runtime.settings = SimpleNamespace(
    instance_id="smoke",
    token="synthetic",
    gateway_url=f"http://127.0.0.1:{server.server_port}",
    run_dir=Path("/run/axp"),
)
hosts = runtime.settings.run_dir / "gh" / "hosts.yml"
credential_request = "protocol=https\nhost=github.com\n\n"
with tempfile.TemporaryDirectory() as workspace:
    os.chdir(workspace)
    command("git", "init")
    command("git", "remote", "add", "origin", "https://github.com/example/smoke.git")
    for token in ("ghs_synthetic_first", "ghs_synthetic_refreshed"):
        answer["token"] = token
        delay = runtime._refresh_github()
        assert 3200 < delay <= 3300
        assert hosts.stat().st_mode & 0o777 == 0o600
        actual = command("gh", "auth", "token", "--hostname", "github.com").strip()
        assert actual == token
        credentials = command("git", "credential", "fill", input=credential_request)
        assert f"password={token}\n" in credentials
        assert command("git", "config", "user.name").strip() == "axp[bot]"
    command("git", "remote", "set-url", "origin", "git@github.com:example/smoke.git")
    assert command("git", "remote", "get-url", "origin").strip() == (
        "https://github.com/example/smoke.git"
    )
    connected = False
    runtime._refresh_github()
    assert not hosts.exists()
    result = subprocess.run(
        ["gh", "auth", "token", "--hostname", "github.com"], capture_output=True
    )
    assert result.returncode != 0
server.shutdown()
print(
    "PASS: gh commands, App credentials, refresh, git helper/identity, "
    "HTTPS, disconnect"
)
