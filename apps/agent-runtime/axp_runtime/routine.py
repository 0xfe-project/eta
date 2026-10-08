"""One routine run: ``python -m axp_runtime.routine``.

The controller starts a fresh container per run, with the same image and
settings as an agent's runtime plus the prompt. The run installs its own
plugins (the routine tools and web search), runs one Codex turn with nobody
to ask for approvals, reports how it ended and exits. Everything it needs
from earlier runs it asks the control plane for; nothing is kept.
"""

import json
import logging
import os
import urllib.request
from dataclasses import replace

import axp_telemetry
from openai_codex.client import CodexClient

from .config import Settings, load_settings
from .runtime import (
    APPROVAL_METHODS,
    DECLINE_RESPONSES,
    _close_client,
    _payload,
    _ThreadResponse,
    codex_config,
    install_plugins,
)

logger = logging.getLogger(__name__)

PLUGINS = ("routine", "grok")


def _approve(method: str, params: dict | None) -> dict:
    """Nobody is there to ask: the run's own work is allowed."""
    kind = APPROVAL_METHODS.get(method)
    if kind == "elicitation":
        return {"action": "accept", "content": {}}
    if kind:
        return {"decision": "accept"}
    return DECLINE_RESPONSES.get(method, {})


def run(settings: Settings, prompt: str) -> tuple[bool, str]:
    """Run the turn; returns whether it completed and its last message."""
    for directory in (settings.workspace_dir, settings.codex_home):
        directory.mkdir(parents=True, exist_ok=True)
    install_plugins(replace(settings, plugins=PLUGINS))
    client = CodexClient(codex_config(settings), approval_handler=_approve)
    try:
        client.start()
        client.initialize()
        params = {
            "cwd": str(settings.workspace_dir),
            "approvalPolicy": "never",
            "developerInstructions": settings.developer_instructions,
        }
        if settings.model:
            params["model"] = settings.model
        thread = client.request(
            "thread/start", params, response_model=_ThreadResponse
        ).thread["id"]
        turn = client.turn_start(thread, [{"type": "text", "text": prompt}]).turn.id
        message = ""
        while True:
            notification = client.next_turn_notification(turn)
            payload = _payload(notification)
            item = payload.get("item") or {}
            if notification.method == "item/completed" and item.get("type") == (
                "agentMessage"
            ):
                message = item.get("text") or ""
            elif notification.method == "turn/completed":
                status = (payload.get("turn") or {}).get("status")
                return status == "completed", message
    finally:
        _close_client(client)


def complete(settings: Settings, body: dict) -> None:
    """Tell the control plane how the run ended (after any ``finish``)."""
    request = urllib.request.Request(
        f"{settings.gateway_url}/internal/v1/routine-runs/"
        f"{settings.instance_id}/complete",
        data=json.dumps(body).encode(),
        method="POST",
    )
    request.add_header("Authorization", f"Bearer {settings.token}")
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=30):
        pass


def main() -> None:
    axp_telemetry.setup("routine-runtime")
    settings = load_settings()
    try:
        completed, message = run(settings, os.environ["AXP_ROUTINE_PROMPT"])
        body = {"completed": completed, "message": message}
    except Exception as exc:
        logger.exception("Routine run failed")
        body = {"completed": False, "message": "", "error": str(exc)[:500]}
    try:
        complete(settings, body)
    finally:
        axp_telemetry.shutdown()


if __name__ == "__main__":
    main()
