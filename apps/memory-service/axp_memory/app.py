"""HTTP surface, reached only through the runtime gateway under /memory.

The gateway authenticates the runtime and sets X-AXP-Agent-Id; that header is
the only identity here, so an agent reaches nothing but its own memories.

  /memory/mcp      MCP (streamable HTTP): remember, recall, forget
  /memory/recall   for the prompt hook: memories relevant to a prompt
  /memory/capture  for the stop hook: a finished turn, remembered later
"""

import logging
import queue
import threading

import anyio
from mcp.server.fastmcp import Context, FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .provider import Memory, MemoryProvider

logger = logging.getLogger(__name__)

AGENT_HEADER = "X-AXP-Agent-Id"
RECALL_LIMIT = 5
# Below this a memory is unrelated to the prompt; it is not worth the context.
RECALL_MIN_SCORE = 0.2
MAX_TEXT = 8000
CAPTURE_BACKLOG = 1000


def create_app(provider: MemoryProvider):
    mcp = FastMCP(
        "memory",
        streamable_http_path="/memory/mcp",
        stateless_http=True,
        json_response=True,
        # Reached through the runtime gateway under its own host name; the
        # network is the trust boundary.
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=False
        ),
    )
    captures = _Captures(provider)

    def agent_of(ctx: Context) -> str:
        agent = _agent(ctx.request_context.request)
        if not agent:
            raise PermissionError("not reached through the runtime gateway")
        return agent

    # Provider calls block (database, embedding); they run in worker threads.
    @mcp.tool()
    async def remember(text: str, ctx: Context) -> dict:
        """Remember a fact for later conversations, as one short statement.

        Use it for lasting facts and preferences the user states or that you
        learn, not for the task at hand.
        """
        message = {"role": "user", "content": text[:MAX_TEXT]}
        added = await anyio.to_thread.run_sync(
            lambda: provider.add(agent_of(ctx), [message], infer=False)
        )
        return _view(added[0]) if added else {}

    @mcp.tool()
    async def recall(query: str, ctx: Context, limit: int = 10) -> list[dict]:
        """Search your memories of earlier conversations."""
        found = await anyio.to_thread.run_sync(
            provider.search, agent_of(ctx), query[:MAX_TEXT], max(1, min(limit, 50))
        )
        return [_view(memory) for memory in found]

    @mcp.tool()
    async def forget(memory_id: str, ctx: Context) -> dict:
        """Forget a memory that is wrong or no longer true, by its id."""
        agent = agent_of(ctx)
        if not await anyio.to_thread.run_sync(provider.delete, agent, memory_id):
            raise ValueError("no such memory")
        return {"forgotten": memory_id}

    @mcp.custom_route("/memory/recall", methods=["POST"])
    async def recall_route(request: Request) -> Response:
        agent = _agent(request)
        if not agent:
            return _error(401, "UNAUTHENTICATED")
        body = await request.json()
        query = str(body.get("query") or "")[:MAX_TEXT]
        if not query.strip():
            return JSONResponse({"memories": []})
        found = await anyio.to_thread.run_sync(
            provider.search, agent, query, RECALL_LIMIT
        )
        relevant = [m for m in found if (m.score or 0) >= RECALL_MIN_SCORE]
        return JSONResponse({"memories": [_view(m) for m in relevant]})

    @mcp.custom_route("/memory/capture", methods=["POST"])
    async def capture_route(request: Request) -> Response:
        agent = _agent(request)
        if not agent:
            return _error(401, "UNAUTHENTICATED")
        body = await request.json()
        messages = [
            {"role": m["role"], "content": str(m["content"])[:MAX_TEXT]}
            for m in body.get("messages") or []
            if m.get("role") in ("user", "assistant") and m.get("content")
        ]
        if messages and not captures.put(agent, messages, body.get("model")):
            return _error(503, "BUSY")
        return Response(status_code=202)

    @mcp.custom_route("/up", methods=["GET"])
    async def up(_: Request) -> Response:
        return Response(status_code=204)

    app = mcp.streamable_http_app()
    app.state.captures = captures
    return app


class _Captures:
    """Finished turns, remembered one at a time in the background.

    Extraction takes a model call; the stop hook that sends a turn must not
    wait for it. Turns still queued when the service stops are lost.
    """

    def __init__(self, provider: MemoryProvider):
        self.provider = provider
        self.queue: queue.Queue = queue.Queue(CAPTURE_BACKLOG)
        threading.Thread(target=self._run, name="captures", daemon=True).start()

    def put(self, agent: str, messages: list[dict], model: str | None) -> bool:
        try:
            self.queue.put_nowait((agent, messages, model))
        except queue.Full:
            return False
        return True

    def _run(self) -> None:
        while True:
            agent, messages, model = self.queue.get()
            try:
                added = self.provider.add(agent, messages, infer=True, model=model)
                logger.info("Remembered %d facts for agent %s", len(added), agent)
            except Exception:
                logger.exception("Could not remember a turn for agent %s", agent)
            finally:
                self.queue.task_done()


def _agent(request: Request) -> str:
    return request.headers.get(AGENT_HEADER, "")


def _view(memory: Memory) -> dict:
    view = {"id": memory.id, "text": memory.text}
    if memory.score is not None:
        view["score"] = round(memory.score, 3)
    return view


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code}}, status_code=status)
