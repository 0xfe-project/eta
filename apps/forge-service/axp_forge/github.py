"""GitHub through one GitHub App, created by and installed for the user.

The App is created from a manifest (the browser posts it to GitHub, GitHub
sends a one-time code back) and its credentials stay in the state directory:
github.json and the private key github.pem. Every call to GitHub uses either
a JWT signed with that key or an installation token minted from it with only
the permissions its purpose needs; tokens are cached until close to expiry.
Nothing here is per agent: every agent acts as the App.
"""

import json
import re
import secrets
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import quote, urlsplit

import httpx
import jwt

API_URL = "https://api.github.com"
WEB_URL = "https://github.com"
# GitHub App names are global on GitHub and at most 34 characters.
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,33}$")
ACCOUNT = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
# What the App may ever do. Workflows are left out: agents cannot change CI.
APP_PERMISSIONS = {
    "contents": "write",
    "pull_requests": "write",
    "issues": "read",
    "actions": "read",
    "checks": "read",
    "statuses": "read",
    "metadata": "read",
}
# What each use gets of it.
READ = {name: "read" for name in APP_PERMISSIONS}
PUSH = {"contents": "write", "metadata": "read"}
PULL_REQUEST = {"pull_requests": "write", "contents": "read", "metadata": "read"}
MANIFEST_TTL = 3600
TOKEN_MARGIN = 600
INSTALLATIONS_TTL = 30
REPOSITORIES_SHOWN = 100


class ForgeError(Exception):
    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def not_connected() -> ForgeError:
    return ForgeError(
        "GITHUB_NOT_CONNECTED",
        "GitHub 还没有连接。请让用户在 AXP 工作区的“能力”页按向导连接 GitHub。",
    )


def not_installed(owner: str) -> ForgeError:
    return ForgeError(
        "GITHUB_NOT_INSTALLED",
        f"AXP 的 GitHub App 没有安装到 {owner}。请让用户在 AXP 工作区的“能力”页"
        "把 App 安装到这个账号或组织，并授权需要的仓库。",
    )


@dataclass
class App:
    id: int
    slug: str
    name: str
    client_id: str
    html_url: str
    owner: str
    owner_type: str  # "User" or "Organization"
    bot_id: int | None = None

    @property
    def settings_url(self) -> str:
        if self.owner_type == "Organization":
            return f"{WEB_URL}/organizations/{self.owner}/settings/apps/{self.slug}"
        return f"{WEB_URL}/settings/apps/{self.slug}"

    @property
    def install_url(self) -> str:
        return f"{WEB_URL}/apps/{self.slug}/installations/new"

    @property
    def identity(self) -> dict | None:
        if self.bot_id is None:
            return None
        bot = f"{self.slug}[bot]"
        return {"name": bot, "email": f"{self.bot_id}+{bot}@users.noreply.github.com"}


def parse_repository(value: str) -> tuple[str, str]:
    """owner/name from "owner/name" or a GitHub remote URL."""
    text = value.strip()
    if text.startswith("git@github.com:"):
        text = text.removeprefix("git@github.com:")
    elif "://" in text:
        url = urlsplit(text)
        if url.hostname != "github.com":
            raise ForgeError("NOT_GITHUB", f"{value} 不是 GitHub 仓库。", 400)
        text = url.path
    parts = text.strip("/").removesuffix(".git").split("/")
    if len(parts) != 2 or not all(parts):
        raise ForgeError(
            "INVALID_REPOSITORY", f"无法识别仓库 {value}，请写成 owner/name。", 400
        )
    return parts[0], parts[1]


class GitHub:
    def __init__(
        self,
        state_dir: Path,
        *,
        api_url: str = API_URL,
        transport: httpx.BaseTransport | None = None,
        clock=time.time,
    ):
        self.state_dir = state_dir
        self.clock = clock
        self.http = httpx.Client(
            base_url=api_url,
            transport=transport,
            timeout=20,
            headers={
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "axp-forge",
            },
        )
        self._lock = threading.Lock()
        self._tokens: dict[tuple, tuple[str, float]] = {}
        self._installations: tuple[float, list[dict]] | None = None

    # --- the App ------------------------------------------------------------

    @property
    def _config(self) -> Path:
        return self.state_dir / "github.json"

    @property
    def _key(self) -> Path:
        return self.state_dir / "github.pem"

    def app(self) -> App | None:
        try:
            return App(**json.loads(self._config.read_text()))
        except FileNotFoundError:
            return None

    def _require(self) -> App:
        app = self.app()
        if app is None:
            raise not_connected()
        return app

    def _save(self, app: App, pem: str | None = None) -> None:
        if pem is not None:
            _write(self._key, pem, private=True)
        _write(self._config, json.dumps(asdict(app), indent=2))

    def start_manifest(self, name: str, organization: str | None, origin: str) -> dict:
        """The form the browser posts to GitHub to create the App."""
        name = name.strip()
        if not NAME.match(name):
            raise ForgeError(
                "INVALID_NAME",
                "App 名称为 1 到 34 个字符，可用字母、数字、空格、点、下划线和连字符。",
                400,
            )
        if organization is not None and not ACCOUNT.match(organization):
            raise ForgeError("INVALID_ORGANIZATION", "组织名称无效。", 400)
        if self.app() is not None:
            raise ForgeError("GITHUB_ALREADY_CONNECTED", "已经连接了一个 GitHub App。")
        url = urlsplit(origin)
        if url.scheme not in ("http", "https") or not url.netloc:
            raise ForgeError("INVALID_ORIGIN", "无法确定 AXP 的访问地址。", 400)
        origin = f"{url.scheme}://{url.netloc}"
        state = secrets.token_urlsafe(24)
        with self._lock:
            pending = self._pending()
            pending[state] = self.clock()
            _write(self.state_dir / "pending.json", json.dumps(pending), private=True)
        manifest = {
            "name": name,
            "url": origin,
            "description": "AXP 的智能体以这个 App 的身份读取仓库、推送分支和打开 PR。",
            # Nothing listens for webhooks; GitHub still wants a URL.
            "hook_attributes": {
                "url": f"{origin}/api/forge/v1/github/webhook",
                "active": False,
            },
            "redirect_url": f"{origin}/api/forge/v1/github/manifest/callback",
            "setup_url": f"{origin}/?view=capabilities",
            "setup_on_update": True,
            "public": False,
            "default_permissions": APP_PERMISSIONS,
            "default_events": [],
        }
        base = (
            f"{WEB_URL}/organizations/{quote(organization)}/settings/apps/new"
            if organization
            else f"{WEB_URL}/settings/apps/new"
        )
        return {
            "action": f"{base}?state={state}",
            "manifest": json.dumps(manifest, ensure_ascii=False),
        }

    def _pending(self) -> dict:
        try:
            pending = json.loads((self.state_dir / "pending.json").read_text())
        except (FileNotFoundError, ValueError):
            pending = {}
        now = self.clock()
        return {k: t for k, t in pending.items() if now - t < MANIFEST_TTL}

    def finish_manifest(self, code: str, state: str) -> App:
        """GitHub's redirect after the App was created: fetch its credentials."""
        with self._lock:
            pending = self._pending()
            if state not in pending:
                raise ForgeError(
                    "MANIFEST_EXPIRED", "这次创建已失效，请回到 AXP 重新开始。", 400
                )
            del pending[state]
            _write(self.state_dir / "pending.json", json.dumps(pending), private=True)
        response = self.http.post(f"/app-manifests/{quote(code)}/conversions")
        if response.status_code != 201:
            raise ForgeError(
                "MANIFEST_FAILED",
                f"GitHub 没有返回 App 的凭据（{response.status_code}），请重新创建。",
                502,
            )
        data = response.json()
        app = App(
            id=data["id"],
            slug=data["slug"],
            name=data["name"],
            client_id=data["client_id"],
            html_url=data["html_url"],
            owner=data["owner"]["login"],
            owner_type=data["owner"].get("type", "User"),
        )
        self._save(app, data["pem"])
        self._bot_id(app)
        return app

    def forget(self) -> None:
        """Drop the App's credentials here; the App on GitHub stays."""
        with self._lock:
            for path in (self._config, self._key):
                path.unlink(missing_ok=True)
            self._tokens.clear()
            self._installations = None

    def _bot_id(self, app: App) -> int | None:
        if app.bot_id is None:
            response = self.http.get(f"/users/{quote(app.slug)}%5Bbot%5D")
            if response.status_code == 200:
                app.bot_id = response.json()["id"]
                self._save(app)
        return app.bot_id

    def identity(self) -> dict:
        app = self._require()
        self._bot_id(app)
        if app.identity is None:
            raise ForgeError(
                "GITHUB_UNAVAILABLE", "暂时无法从 GitHub 读取 App 的身份。", 502
            )
        return app.identity

    # --- calls as the App ---------------------------------------------------

    def _jwt(self, app: App) -> str:
        now = int(self.clock())
        return jwt.encode(
            {"iat": now - 60, "exp": now + 540, "iss": str(app.id)},
            self._key.read_text(),
            algorithm="RS256",
        )

    def _as_app(self, method: str, path: str, **kwargs) -> httpx.Response:
        app = self._require()
        response = self.http.request(
            method,
            path,
            headers={"Authorization": f"Bearer {self._jwt(app)}"},
            **kwargs,
        )
        if response.status_code == 401:
            raise ForgeError(
                "GITHUB_APP_GONE",
                "GitHub 不认这个 App 了（可能已在 GitHub 上删除）。请断开后重新连接。",
                502,
            )
        return response

    def installations(self, fresh: bool = False) -> list[dict]:
        with self._lock:
            cached = self._installations
        if cached and not fresh and self.clock() - cached[0] < INSTALLATIONS_TTL:
            return cached[1]
        response = self._as_app("GET", "/app/installations", params={"per_page": 100})
        _check(response)
        installations = response.json()
        with self._lock:
            self._installations = (self.clock(), installations)
        return installations

    def installation_for(self, owner: str) -> dict:
        for fresh in (False, True):
            for installation in self.installations(fresh):
                if installation["account"]["login"].lower() == owner.lower():
                    return installation
        raise not_installed(owner)

    def token(
        self, installation_id: int, permissions: dict, repository: str | None = None
    ) -> tuple[str, float]:
        """An installation token with these permissions, for one repository
        or all the installation's."""
        key = (installation_id, repository, tuple(sorted(permissions.items())))
        with self._lock:
            cached = self._tokens.get(key)
        if cached and cached[1] - self.clock() > TOKEN_MARGIN:
            return cached
        body: dict = {"permissions": permissions}
        if repository:
            body["repositories"] = [repository]
        response = self._as_app(
            "POST", f"/app/installations/{installation_id}/access_tokens", json=body
        )
        if response.status_code == 422 and repository:
            raise ForgeError(
                "GITHUB_REPOSITORY_NOT_GRANTED",
                f"AXP 的 GitHub App 没有被授权访问仓库 {repository}。请让用户在 AXP"
                "工作区的“能力”页管理 App 能访问的仓库。",
            )
        _check(response)
        data = response.json()
        expires = _timestamp(data["expires_at"])
        with self._lock:
            self._tokens[key] = (data["token"], expires)
        return data["token"], expires

    # --- for runtimes ---------------------------------------------------------

    def credential(self, owner: str, name: str) -> dict:
        """What git needs to fetch and push owner/name."""
        installation = self.installation_for(owner)
        token, expires = self.token(installation["id"], PUSH, name)
        return {
            "username": "x-access-token",
            "password": token,
            "expires_at": int(expires),
        }

    def read_token(self, owner: str) -> dict:
        """A read-only token for gh, covering the installation of owner."""
        installation = self.installation_for(owner)
        token, expires = self.token(installation["id"], READ)
        return {"token": token, "expires_at": int(expires)}

    def open_pull_request(
        self,
        repository: str,
        head: str,
        title: str,
        body: str = "",
        base: str | None = None,
        draft: bool = False,
    ) -> dict:
        owner, name = parse_repository(repository)
        installation = self.installation_for(owner)
        token, _ = self.token(installation["id"], PULL_REQUEST, name)
        headers = {"Authorization": f"Bearer {token}"}
        if not base:
            response = self.http.get(f"/repos/{owner}/{name}", headers=headers)
            _check(response)
            base = response.json()["default_branch"]
        response = self.http.post(
            f"/repos/{owner}/{name}/pulls",
            headers=headers,
            json={
                "title": title,
                "body": body,
                "head": head,
                "base": base,
                "draft": draft,
            },
        )
        if response.status_code == 201:
            pull = response.json()
            return {"url": pull["html_url"], "number": pull["number"], "created": True}
        reasons = _reasons(response)
        if response.status_code == 422 and "already exists" in reasons:
            branch = head if ":" in head else f"{owner}:{head}"
            existing = self.http.get(
                f"/repos/{owner}/{name}/pulls",
                headers=headers,
                params={"head": branch, "state": "open"},
            )
            if existing.status_code == 200 and existing.json():
                pull = existing.json()[0]
                return {
                    "url": pull["html_url"],
                    "number": pull["number"],
                    "created": False,
                }
        reasons = reasons or "没有说明原因"
        raise ForgeError(
            "PULL_REQUEST_FAILED",
            f"GitHub 拒绝创建 PR（{response.status_code}）：{reasons}",
            502 if response.status_code >= 500 else 400,
        )

    # --- for the browser ------------------------------------------------------

    def status(self, fresh: bool = False) -> dict:
        app = self.app()
        if app is None:
            return {"state": "not_connected", "app": None, "installations": []}
        view = {
            "app": {
                "name": app.name,
                "slug": app.slug,
                "owner": app.owner,
                "owner_type": app.owner_type,
                "html_url": app.html_url,
                "settings_url": app.settings_url,
                "install_url": app.install_url,
            },
            "installations": [],
        }
        try:
            installations = self.installations(fresh)
            view["installations"] = [self._installation_view(i) for i in installations]
        except ForgeError as error:
            return {
                **view,
                "state": "error",
                "error": {"code": error.code, "message": error.message},
            }
        except httpx.HTTPError:
            return {
                **view,
                "state": "error",
                "error": {
                    "code": "GITHUB_UNREACHABLE",
                    "message": "暂时连不上 GitHub。",
                },
            }
        view["state"] = "ready" if view["installations"] else "not_installed"
        return view

    def _installation_view(self, installation: dict) -> dict:
        token, _ = self.token(installation["id"], {"metadata": "read"})
        response = self.http.get(
            "/installation/repositories",
            headers={"Authorization": f"Bearer {token}"},
            params={"per_page": REPOSITORIES_SHOWN},
        )
        _check(response)
        data = response.json()
        return {
            "id": installation["id"],
            "account": installation["account"]["login"],
            "account_type": installation["account"].get("type", "User"),
            "repository_selection": installation.get(
                "repository_selection", "selected"
            ),
            "repositories": [r["full_name"] for r in data.get("repositories", [])],
            "total_repositories": data.get("total_count", 0),
            "manage_url": installation.get("html_url"),
        }


def _check(response: httpx.Response) -> None:
    if response.status_code >= 400:
        reasons = _reasons(response) or "没有说明原因"
        raise ForgeError(
            "GITHUB_ERROR",
            f"GitHub 返回 {response.status_code}：{reasons}",
            502,
        )


def _reasons(response: httpx.Response) -> str:
    try:
        data = response.json()
    except ValueError:
        return ""
    details = [
        e.get("message", "") for e in data.get("errors", []) if isinstance(e, dict)
    ]
    return "；".join(m for m in [data.get("message", ""), *details] if m)


def _timestamp(iso: str) -> float:
    from datetime import datetime

    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def _write(path: Path, text: str, private: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    if private:
        tmp.chmod(0o600)
    tmp.replace(path)
