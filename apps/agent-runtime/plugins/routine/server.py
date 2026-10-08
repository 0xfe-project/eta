"""The ``routine`` plugin's MCP server (stdio), installed for routine runs only.

A run looks back through the control plane: its routine's earlier runs,
their reports and the user's feedback on them. It ends by calling ``finish``.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request

from mcp.server.fastmcp import FastMCP

# The runtime key is "<run id>.<token>".
RUN_ID, _, TOKEN = os.environ.get("AXP_RUNTIME_LLM_KEY", "").partition(".")
BASE = f"{os.environ.get('AXP_GATEWAY_URL', '')}/internal/v1/routine-runs/{RUN_ID}"

mcp = FastMCP("routine")


def _call(method: str, path: str, body: dict | None = None):
    request = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
    )
    request.add_header("Authorization", f"Bearer {TOKEN}")
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read() or b"null")
    except urllib.error.HTTPError as exc:
        error = json.loads(exc.read() or b"{}").get("error") or {}
        raise ValueError(error.get("message") or f"HTTP {exc.code}") from exc


@mcp.tool()
def list_runs(before: str | None = None, limit: int = 10) -> list[dict]:
    """List this routine's earlier runs, newest first: when, the outcome, the
    report's title and the user's feedback. Pass ``before`` (a run's
    started_at) to page back."""
    query = urllib.parse.urlencode(
        {"limit": limit, **({"before": before} if before else {})}
    )
    return _call("GET", f"/runs?{query}")


@mcp.tool()
def get_run(run_id: str) -> dict:
    """One earlier run in full: its report and the user's feedback."""
    return _call("GET", f"/runs/{urllib.parse.quote(run_id)}")


@mcp.tool()
def search_runs(query: str, limit: int = 10) -> list[dict]:
    """Earlier runs whose report mentions ``query`` (a word, name or URL),
    newest first. Use it to check whether something was already sent."""
    params = urllib.parse.urlencode({"q": query, "limit": limit})
    return _call("GET", f"/runs?{params}")


@mcp.tool()
def finish(report: str | None, handoff: str) -> str:
    """End this run, exactly once.

    ``report``: the report for the user in Markdown, starting with a
    "# title" line; null when there is nothing new worth sending.
    ``handoff``: a few sentences for the next run: what was sent, what you
    noticed, what to watch for next time.
    """
    _call("POST", "/finish", {"report": report, "handoff": handoff})
    return "已结束本次运行。"


if __name__ == "__main__":
    mcp.run()
