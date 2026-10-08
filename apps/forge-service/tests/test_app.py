import json
from urllib.parse import parse_qs, urlsplit

import httpx
import jwt
import pytest
from axp_forge.app import create_app
from axp_forge.github import GitHub
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from starlette.testclient import TestClient

AGENT = {"X-AXP-Agent-Id": "agent-1"}
ORIGIN = "https://axp.example.com"


class FakeGitHub:
    """The parts of GitHub's API the service uses, for one App."""

    def __init__(self):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.pem = key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode()
        self.public_key = key.public_key()
        self.installations = []
        # installation id -> repositories it may access
        self.repositories: dict[int, list[str]] = {}
        self.tokens: list[dict] = []
        self.pulls: list[dict] = []
        self.app_deleted = False

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        auth = request.headers.get("Authorization", "")
        if path == "/app-manifests/good-code/conversions":
            return httpx.Response(
                201,
                json={
                    "id": 77,
                    "slug": "axp-test",
                    "name": "AXP Test",
                    "client_id": "Iv1.abc",
                    "html_url": "https://github.com/apps/axp-test",
                    "owner": {"login": "akarachen", "type": "User"},
                    "pem": self.pem,
                },
            )
        if path.startswith("/app-manifests/"):
            return httpx.Response(404, json={"message": "Not Found"})
        if path == "/users/axp-test[bot]":
            return httpx.Response(200, json={"id": 4242, "login": "axp-test[bot]"})
        if path.startswith("/app/"):
            if self.app_deleted:
                return httpx.Response(401, json={"message": "Bad credentials"})
            claims = jwt.decode(
                auth.removeprefix("Bearer "), self.public_key, algorithms=["RS256"]
            )
            assert claims["iss"] == "77"
            if path == "/app/installations":
                return httpx.Response(200, json=self.installations)
            installation = int(path.split("/")[3])
            body = json.loads(request.content)
            wanted = body.get("repositories")
            if wanted and not set(wanted) <= set(self.repositories[installation]):
                return httpx.Response(
                    422,
                    json={
                        "message": "There is at least one repository that does "
                        "not exist or is not accessible"
                    },
                )
            token = f"ghs_{len(self.tokens)}"
            self.tokens.append({"token": token, "installation": installation, **body})
            return httpx.Response(
                201, json={"token": token, "expires_at": "2099-01-01T00:00:00Z"}
            )
        assert auth.startswith("Bearer ghs_"), path
        if path == "/installation/repositories":
            [granted] = [
                t for t in self.tokens if t["token"] == auth.removeprefix("Bearer ")
            ]
            names = self.repositories[granted["installation"]]
            owner = next(
                i["account"]["login"]
                for i in self.installations
                if i["id"] == granted["installation"]
            )
            return httpx.Response(
                200,
                json={
                    "total_count": len(names),
                    "repositories": [{"full_name": f"{owner}/{n}"} for n in names],
                },
            )
        if path == "/repos/akarachen/axp":
            return httpx.Response(200, json={"default_branch": "main"})
        if path == "/repos/akarachen/axp/pulls" and request.method == "POST":
            body = json.loads(request.content)
            if any(p["head"] == body["head"] for p in self.pulls):
                return httpx.Response(
                    422,
                    json={
                        "message": "Validation Failed",
                        "errors": [
                            {
                                "message": "A pull request already exists for "
                                f"akarachen:{body['head']}."
                            }
                        ],
                    },
                )
            if body["head"] == "empty":
                return httpx.Response(
                    422,
                    json={
                        "message": "Validation Failed",
                        "errors": [{"message": "No commits between main and empty"}],
                    },
                )
            number = len(self.pulls) + 1
            self.pulls.append({**body, "number": number})
            return httpx.Response(
                201,
                json={
                    "number": number,
                    "html_url": f"https://github.com/akarachen/axp/pull/{number}",
                },
            )
        if path == "/repos/akarachen/axp/pulls":
            head = parse_qs(request.url.query.decode())["head"][0].split(":")[1]
            found = [p for p in self.pulls if p["head"] == head]
            return httpx.Response(
                200,
                json=[
                    {
                        "number": p["number"],
                        "html_url": f"https://github.com/akarachen/axp/pull/{p['number']}",
                    }
                    for p in found
                ],
            )
        return httpx.Response(
            404, json={"message": f"no fake for {request.method} {path}"}
        )

    def install(self, account: str, repositories: list[str], account_type="User"):
        installation_id = 100 + len(self.installations)
        self.installations.append(
            {
                "id": installation_id,
                "account": {"login": account, "type": account_type},
                "repository_selection": "selected",
                "html_url": f"https://github.com/settings/installations/{installation_id}",
            }
        )
        self.repositories[installation_id] = repositories


@pytest.fixture
def fake():
    return FakeGitHub()


@pytest.fixture
def github(fake, tmp_path):
    return GitHub(tmp_path / "state", transport=httpx.MockTransport(fake.handle))


@pytest.fixture
def client(github):
    with TestClient(create_app(github)) as client:
        yield client


def connect(client) -> None:
    """The browser's side of the manifest flow, through GitHub's redirect."""
    form = client.post(
        "/api/forge/v1/github/manifest", json={"name": "AXP Test", "origin": ORIGIN}
    ).json()
    state = parse_qs(urlsplit(form["action"]).query)["state"][0]
    response = client.get(
        "/api/forge/v1/github/manifest/callback",
        params={"code": "good-code", "state": state},
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert response.headers["location"] == "/?view=capabilities&github=created"


def call_tool(client, name, **arguments):
    response = client.post(
        "/forge/mcp",
        headers={**AGENT, "Accept": "application/json, text/event-stream"},
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["result"]


class TestConnecting:
    def test_not_connected(self, client):
        assert client.get("/api/forge/v1/github").json() == {
            "state": "not_connected",
            "app": None,
            "installations": [],
        }

    def test_manifest_for_a_user_and_an_organization(self, client):
        form = client.post(
            "/api/forge/v1/github/manifest",
            json={"name": "AXP Test", "origin": f"{ORIGIN}/ignored"},
        ).json()
        assert form["action"].startswith("https://github.com/settings/apps/new?state=")
        manifest = json.loads(form["manifest"])
        assert (
            manifest["redirect_url"]
            == f"{ORIGIN}/api/forge/v1/github/manifest/callback"
        )
        assert manifest["setup_url"] == f"{ORIGIN}/?view=capabilities"
        assert manifest["hook_attributes"]["active"] is False
        assert manifest["default_permissions"]["contents"] == "write"
        assert "workflows" not in manifest["default_permissions"]
        org = client.post(
            "/api/forge/v1/github/manifest",
            json={"name": "AXP Test", "organization": "acme", "origin": ORIGIN},
        ).json()
        assert org["action"].startswith(
            "https://github.com/organizations/acme/settings/apps/new?state="
        )

    @pytest.mark.parametrize(
        "body",
        [
            {"name": "", "origin": ORIGIN},
            {"name": "x" * 35, "origin": ORIGIN},
            {"name": "AXP", "organization": "bad org", "origin": ORIGIN},
            {"name": "AXP", "origin": "javascript:alert(1)"},
        ],
    )
    def test_invalid_manifest_requests(self, client, body):
        response = client.post("/api/forge/v1/github/manifest", json=body)
        assert response.status_code == 400
        assert response.json()["error"]["message"]

    def test_creating_then_installing(self, client, fake, github):
        connect(client)
        status = client.get("/api/forge/v1/github").json()
        assert status["state"] == "not_installed"
        assert (
            status["app"]["install_url"]
            == "https://github.com/apps/axp-test/installations/new"
        )
        assert (
            status["app"]["settings_url"] == "https://github.com/settings/apps/axp-test"
        )
        assert (github.state_dir / "github.pem").stat().st_mode & 0o777 == 0o600
        fake.install("akarachen", ["axp", "notes"])
        status = client.get("/api/forge/v1/github?fresh=1").json()
        assert status["state"] == "ready"
        [installation] = status["installations"]
        assert installation["account"] == "akarachen"
        assert installation["repositories"] == ["akarachen/axp", "akarachen/notes"]
        assert installation["manage_url"].endswith("/installations/100")

    def test_a_callback_needs_a_fresh_state(self, client):
        response = client.get(
            "/api/forge/v1/github/manifest/callback",
            params={"code": "good-code", "state": "forged"},
            follow_redirects=False,
        )
        assert "github_error=" in response.headers["location"]
        assert client.get("/api/forge/v1/github").json()["state"] == "not_connected"

    def test_an_expired_code(self, client):
        form = client.post(
            "/api/forge/v1/github/manifest", json={"name": "AXP", "origin": ORIGIN}
        ).json()
        state = parse_qs(urlsplit(form["action"]).query)["state"][0]
        response = client.get(
            "/api/forge/v1/github/manifest/callback",
            params={"code": "stale", "state": state},
            follow_redirects=False,
        )
        assert "github_error=" in response.headers["location"]

    def test_one_app_at_a_time_and_forgetting(self, client):
        connect(client)
        again = client.post(
            "/api/forge/v1/github/manifest", json={"name": "AXP 2", "origin": ORIGIN}
        )
        assert again.json()["error"]["code"] == "GITHUB_ALREADY_CONNECTED"
        assert client.delete("/api/forge/v1/github").status_code == 204
        assert client.get("/api/forge/v1/github").json()["state"] == "not_connected"

    def test_an_app_deleted_on_github(self, client, fake):
        connect(client)
        fake.app_deleted = True
        status = client.get("/api/forge/v1/github?fresh=1").json()
        assert status["state"] == "error"
        assert status["error"]["code"] == "GITHUB_APP_GONE"


class TestRuntime:
    def test_everything_says_how_to_connect_first(self, client):
        for path, body in [
            ("/forge/credential", {"host": "github.com", "path": "a/b.git"}),
            ("/forge/gh-token", {"owner": "a"}),
        ]:
            response = client.post(path, headers=AGENT, json=body)
            assert response.status_code == 409
            assert "能力" in response.json()["error"]["message"]
        result = call_tool(
            client, "open_pull_request", repository="a/b", head="x", title="t"
        )
        assert result["isError"]
        assert "能力" in result["content"][0]["text"]

    def test_routes_need_the_gateway_header(self, client):
        response = client.post(
            "/forge/credential", json={"host": "github.com", "path": "a/b"}
        )
        assert response.status_code == 401

    def test_git_credential_for_one_repository(self, client, fake):
        connect(client)
        fake.install("akarachen", ["axp"])
        response = client.post(
            "/forge/credential",
            headers=AGENT,
            json={"host": "github.com", "path": "akarachen/axp.git"},
        )
        assert response.json()["username"] == "x-access-token"
        [token] = fake.tokens
        assert token["repositories"] == ["axp"]
        assert token["permissions"] == {"contents": "write", "metadata": "read"}
        # Cached until close to expiry.
        client.post(
            "/forge/credential",
            headers=AGENT,
            json={"host": "github.com", "path": "akarachen/axp"},
        )
        assert len(fake.tokens) == 1

    def test_repositories_the_app_cannot_reach(self, client, fake):
        connect(client)
        fake.install("akarachen", ["axp"])
        not_granted = client.post(
            "/forge/credential",
            headers=AGENT,
            json={"host": "github.com", "path": "akarachen/secret"},
        )
        assert not_granted.json()["error"]["code"] == "GITHUB_REPOSITORY_NOT_GRANTED"
        other = client.post(
            "/forge/credential",
            headers=AGENT,
            json={"host": "github.com", "path": "someone/else"},
        )
        assert other.json()["error"]["code"] == "GITHUB_NOT_INSTALLED"

    def test_gh_gets_a_read_only_token(self, client, fake):
        connect(client)
        fake.install("acme", ["web"], account_type="Organization")
        response = client.post("/forge/gh-token", headers=AGENT, json={"owner": "ACME"})
        assert response.json()["token"].startswith("ghs_")
        assert set(fake.tokens[-1]["permissions"].values()) == {"read"}
        assert "repositories" not in fake.tokens[-1]

    def test_identity(self, client):
        connect(client)
        assert client.get("/forge/identity", headers=AGENT).json() == {
            "name": "axp-test[bot]",
            "email": "4242+axp-test[bot]@users.noreply.github.com",
        }

    def test_open_pull_request(self, client, fake):
        connect(client)
        fake.install("akarachen", ["axp"])
        result = call_tool(
            client,
            "open_pull_request",
            repository="git@github.com:akarachen/axp.git",
            head="feature",
            title="Add feature",
            body="Why",
        )
        assert json.loads(result["content"][0]["text"]) == {
            "url": "https://github.com/akarachen/axp/pull/1",
            "number": 1,
            "created": True,
        }
        assert fake.pulls[0]["base"] == "main"
        assert fake.tokens[-1]["permissions"]["pull_requests"] == "write"
        again = call_tool(
            client,
            "open_pull_request",
            repository="akarachen/axp",
            head="feature",
            title="x",
        )
        assert json.loads(again["content"][0]["text"])["created"] is False
        empty = call_tool(
            client,
            "open_pull_request",
            repository="akarachen/axp",
            head="empty",
            title="x",
        )
        assert empty["isError"]
        assert "No commits" in empty["content"][0]["text"]
