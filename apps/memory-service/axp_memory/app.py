"""HTTP surface, for runtimes under /memory and for the browser under /api/memory.

The runtime gateway authenticates the runtime and sets X-AXP-Agent-Id; that
header is the only identity there, so an agent reaches nothing but its own
memories.

  /memory/mcp      MCP (streamable HTTP): remember, recall, forget
  /memory/recall   for the prompt hook: memories relevant to a prompt
  /memory/capture  for the stop hook: a finished turn, remembered later

The browser's gateway forwards only /api/memory, where the agent is named in
the path: the user sees and edits every agent's memories.

  /api/memory/v1/agents/{agent}/memories       GET (?q= searches), POST
  /api/memory/v1/agents/{agent}/memories/{id}  DELETE
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
# Below this a memory is unrelated to the prompt or search; it is not worth
# the context, nor a place in search results.
RECALL_MIN_SCORE = 0.2
MAX_TEXT = 8000
CAPTURE_BACKLOG = 1000
SEARCH_LIMIT = 50


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
            lambda: provider.add(
                agent_of(ctx),
                [message],
                source="agent",
                infer=False,
                group_id=ctx.request_context.request.headers.get("X-AXP-Group-Id")
                or None,
            )
        )
        return _view(added[0]) if added else {}

    @mcp.tool()
    async def recall(query: str, ctx: Context, limit: int = 10) -> list[dict]:
        """Search your memories; group_context marks this group or another group."""
        found = await anyio.to_thread.run_sync(
            provider.search, agent_of(ctx), query[:MAX_TEXT], max(1, min(limit, 50))
        )
        group_id = ctx.request_context.request.headers.get("X-AXP-Group-Id")
        return [_recall_view(memory, group_id) for memory in found]

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
        group_id = request.headers.get("X-AXP-Group-Id")
        return JSONResponse({"memories": [_recall_view(m, group_id) for m in relevant]})

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
        if messages and not captures.put(
            agent,
            messages,
            body.get("model"),
            group_id=request.headers.get("X-AXP-Group-Id") or None,
        ):
            return _error(503, "BUSY")
        return Response(status_code=202)

    @mcp.custom_route("/api/memory/v1/agents/{agent}/memories", methods=["GET", "POST"])
    async def memories_route(request: Request) -> Response:
        agent = request.path_params["agent"]
        if request.method == "POST":
            body = await request.json()
            text = str(body.get("text") or "").strip()[:MAX_TEXT]
            if not text:
                return _error(400, "INVALID_TEXT", "记忆内容不能为空。")
            message = {"role": "user", "content": text}
            added = await anyio.to_thread.run_sync(
                lambda: provider.add(agent, [message], source="user", infer=False)
            )
            return JSONResponse(_view(added[0]), status_code=201)
        source = request.query_params.get("source") or None
        if source is not None and source not in {"conversation", "agent", "user"}:
            return _error(400, "INVALID_SOURCE", "无效的记忆种类。")
        group_id = request.query_params.get("group_id") or None
        query = request.query_params.get("q", "").strip()[:MAX_TEXT]
        if query:
            found = await anyio.to_thread.run_sync(
                lambda: provider.search(
                    agent, query, SEARCH_LIMIT, source=source, group_id=group_id
                )
            )
            found = [m for m in found if (m.score or 0) >= RECALL_MIN_SCORE]
        else:
            found = await anyio.to_thread.run_sync(
                lambda: provider.list(agent, source=source, group_id=group_id)
            )
            # Newest first; ISO 8601 in UTC sorts as text.
            found.sort(key=lambda m: m.created_at or "", reverse=True)
        return JSONResponse({"memories": [_view(m) for m in found]})

    @mcp.custom_route(
        "/api/memory/v1/agents/{agent}/memories/{memory_id}", methods=["DELETE"]
    )
    async def memory_route(request: Request) -> Response:
        agent, memory_id = (
            request.path_params["agent"],
            request.path_params["memory_id"],
        )
        if not await anyio.to_thread.run_sync(provider.delete, agent, memory_id):
            return _error(404, "NOT_FOUND", "这条记忆不存在。")
        return Response(status_code=204)

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

    def put(
        self,
        agent: str,
        messages: list[dict],
        model: str | None,
        *,
        group_id=None,
    ) -> bool:
        try:
            self.queue.put_nowait((agent, messages, model, group_id))
        except queue.Full:
            return False
        return True

    def _run(self) -> None:
        while True:
            agent, messages, model, group_id = self.queue.get()
            try:
                added = self.provider.add(
                    agent,
                    messages,
                    source="conversation",
                    infer=True,
                    model=model,
                    group_id=group_id,
                )
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
    if memory.created_at is not None:
        view["created_at"] = memory.created_at
    if memory.source is not None:
        view["source"] = memory.source
    if memory.source_group_id is not None:
        view["source_group_id"] = memory.source_group_id
    return view


def _recall_view(memory: Memory, group_id: str | None) -> dict:
    view = _view(memory)
    source = view.pop("source_group_id", None)
    if source is not None:
        view["group_context"] = "this" if source == group_id else "other"
    return view


def _error(status: int, code: str, message: str | None = None) -> JSONResponse:
    error = {"code": code}
    if message:
        error["message"] = message
    return JSONResponse({"error": error}, status_code=status)
