"""The ``approval`` plugin's MCP server (stdio).

An akhook ``ask`` rule (/etc/akhook/akhook.yml) blocks a command and leaves a
request; ``request_approval`` shows it to the user through MCP elicitation
and, once they accept, grants it, so the identical command passes once. It
knows nothing about any particular rule.
"""

import json
import subprocess

from mcp.server.fastmcp import Context, FastMCP

AKHOOK = "/usr/local/bin/akhook"
# What the product shows the user is capped at 500 characters.
MESSAGE_CHARS = 500
# A form without fields: the user only accepts or declines. Written out rather
# than generated from a model, which would add a title and description.
CONFIRMATION = {"type": "object", "properties": {}}

mcp = FastMCP("approval")


def _akhook(*args: str) -> str:
    done = subprocess.run(
        [AKHOOK, "approval", *args], capture_output=True, text=True, timeout=10
    )
    if done.returncode != 0:
        raise ValueError(done.stderr.strip() or f"akhook approval {args[0]} failed")
    return done.stdout


def _message(request: dict) -> str:
    reasons = "\n".join(rule["message"] for rule in request.get("rules", []))
    calls = []
    for candidate in request.get("candidates", []):
        if candidate.get("type") == "shell_exec":
            calls.append(candidate["command"])
        else:
            calls.append(f"{candidate.get('action')} {candidate.get('path')}")
    message = f"{reasons}\n\n" + "\n".join(calls)
    if len(message) > MESSAGE_CHARS:
        message = message[: MESSAGE_CHARS - 1] + "…"
    return message


@mcp.tool()
async def request_approval(request_id: str, ctx: Context) -> str:
    """Ask the user to approve a command that an AXP rule held back.

    Call this only with the request_id from such a rule's message. Once the
    user approves, run exactly the same command again; it then passes once.
    """
    request = json.loads(_akhook("show", request_id))
    answer = await ctx.request_context.session.elicit_form(
        message=_message(request),
        requestedSchema=CONFIRMATION,
        related_request_id=ctx.request_id,
    )
    if answer.action == "accept":
        _akhook("grant", request_id)
        return "用户同意了。现在原样重新执行这条命令，只能执行一次。"
    if answer.action == "decline":
        return "用户拒绝了。不要执行这条命令，也不要换个写法绕过。"
    return "用户没有确认。不要执行这条命令。"


if __name__ == "__main__":
    mcp.run()
