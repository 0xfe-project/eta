"""HTTP surface, for runtimes under /forge and for the browser under /api/forge.

The runtime gateway authenticates the runtime and sets X-AXP-Agent-Id; routes
under /forge require it. The browser's gateway forwards /api/forge, where the
user connects the GitHub App.

  /forge/mcp                  MCP (streamable HTTP): open_pull_request
  /forge/credential           POST {host, path}: git's credential for a repo
  /forge/gh-token             POST {owner}: a read-only token for gh
  /forge/identity             GET: the App's commit identity

  /api/forge/v1/github                     GET status (?fresh=1), DELETE
  /api/forge/v1/github/manifest            POST {name, organization?, origin}
  /api/forge/v1/github/manifest/callback   GitHub's redirect after creation
"""

import logging
from urllib.parse import quote

import anyio
import httpx
from mcp.server.fastmcp import Context, FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response

from .github import ForgeError, GitHub, parse_repository

logger = logging.getLogger(__name__)

AGENT_HEADER = "X-AXP-Agent-Id"
CAPABILITIES = "/?view=capabilities"


def create_app(github: GitHub):
    mcp = FastMCP(
        "forge",
        streamable_http_path="/forge/mcp",
        stateless_http=True,
        json_response=True,
        # Reached through the runtime gateway under its own host name; the
        # network is the trust boundary.
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=False
        ),
    )

    @mcp.tool()
    async def open_pull_request(
        repository: str,
        head: str,
        title: str,
        ctx: Context,
        body: str = "",
        base: str | None = None,
        draft: bool = False,
    ) -> dict:
        """Open a GitHub pull request as AXP's GitHub App.

        Push the branch first. repository is "owner/name" or the remote URL
        (`git remote get-url origin`); head is the pushed branch; base
        defaults to the repository's default branch. If a pull request for
        head is already open, it is returned instead. Never use `gh pr
        create`.
        """
        if not ctx.request_context.request.headers.get(AGENT_HEADER):
            raise PermissionError("not reached through the runtime gateway")
        try:
            return await anyio.to_thread.run_sync(
                lambda: github.open_pull_request(
                    repository, head, title, body, base, draft
                )
            )
        except ForgeError as error:
            raise ValueError(error.message) from error

    def runtime_route(path: str, methods: list[str]):
        """A route for runtimes; GitHub's answers become JSON errors."""

        def wrap(handler):
            async def route(request: Request) -> Response:
                if not request.headers.get(AGENT_HEADER):
                    return _error(ForgeError("UNAUTHENTICATED", "unauthenticated", 401))
                try:
                    return JSONResponse(await handler(request))
                except ForgeError as error:
                    return _error(error)
                except httpx.HTTPError:
                    logger.exception("GitHub unreachable")
                    return _error(
                        ForgeError("GITHUB_UNREACHABLE", "暂时连不上 GitHub。", 502)
                    )

            mcp.custom_route(path, methods=methods)(route)
            return handler

        return wrap

    @runtime_route("/forge/credential", ["POST"])
    async def credential(request: Request) -> dict:
        body = await request.json()
        if body.get("host") != "github.com":
            raise ForgeError("NOT_GITHUB", "只支持 github.com。", 404)
        owner, name = parse_repository(str(body.get("path") or ""))
        return await anyio.to_thread.run_sync(github.credential, owner, name)

    @runtime_route("/forge/gh-token", ["POST"])
    async def gh_token(request: Request) -> dict:
        owner = str((await request.json()).get("owner") or "")
        if not owner:
            raise ForgeError("INVALID_OWNER", "缺少仓库所属的账号。", 400)
        return await anyio.to_thread.run_sync(github.read_token, owner)

    @runtime_route("/forge/identity", ["GET"])
    async def identity(request: Request) -> dict:
        return await anyio.to_thread.run_sync(github.identity)

    @mcp.custom_route("/api/forge/v1/github", methods=["GET", "DELETE"])
    async def github_route(request: Request) -> Response:
        if request.method == "DELETE":
            await anyio.to_thread.run_sync(github.forget)
            return Response(status_code=204)
        fresh = request.query_params.get("fresh") == "1"
        return JSONResponse(await anyio.to_thread.run_sync(github.status, fresh))

    @mcp.custom_route("/api/forge/v1/github/manifest", methods=["POST"])
    async def manifest_route(request: Request) -> Response:
        body = await request.json()
        organization = str(body.get("organization") or "").strip() or None
        try:
            form = github.start_manifest(
                str(body.get("name") or ""), organization, str(body.get("origin") or "")
            )
        except ForgeError as error:
            return _error(error)
        return JSONResponse(form)

    @mcp.custom_route("/api/forge/v1/github/manifest/callback", methods=["GET"])
    async def manifest_callback(request: Request) -> Response:
        code = request.query_params.get("code", "")
        state = request.query_params.get("state", "")
        try:
            await anyio.to_thread.run_sync(github.finish_manifest, code, state)
        except ForgeError as error:
            return RedirectResponse(
                f"{CAPABILITIES}&github_error={quote(error.message)}", status_code=303
            )
        except httpx.HTTPError:
            logger.exception("GitHub unreachable")
            message = quote("暂时连不上 GitHub，请重新创建。")
            return RedirectResponse(f"{CAPABILITIES}&github_error={message}", 303)
        return RedirectResponse(f"{CAPABILITIES}&github=created", status_code=303)

    @mcp.custom_route("/up", methods=["GET"])
    async def up(request: Request) -> Response:
        return Response("ok")

    return mcp.streamable_http_app()


def _error(error: ForgeError) -> JSONResponse:
    return JSONResponse(
        {"error": {"code": error.code, "message": error.message}},
        status_code=error.status,
    )
