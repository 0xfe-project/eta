"""Built-in ``tasks`` MCP module (stdio).

Tasks live in the agent's workspace so they follow the workspace storage.
Module config arrives in ``AXP_MCP_CONFIG`` as validated JSON.
"""

import json
import os
import uuid
from pathlib import Path

from mcp.server.fastmcp import FastMCP

CONFIG = json.loads(os.environ.get("AXP_MCP_CONFIG") or "{}")
STORE = (
    Path(os.environ.get("AXP_WORKSPACE_DIR", "/mnt/workspace")) / ".axp" / "tasks.json"
)
MAX_TASKS = int(CONFIG.get("max_tasks", 200))

mcp = FastMCP("tasks")


def _load() -> list[dict]:
    try:
        return json.loads(STORE.read_text())
    except (FileNotFoundError, ValueError):
        return []


def _save(tasks: list[dict]) -> None:
    STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(tasks, ensure_ascii=False, indent=2))
    tmp.replace(STORE)


@mcp.tool()
def list_tasks() -> list[dict]:
    """List the agent's tasks."""
    return _load()


@mcp.tool()
def create_task(title: str) -> dict:
    """Create a task with the given title."""
    tasks = _load()
    if len(tasks) >= MAX_TASKS:
        raise ValueError("task limit reached")
    task = {"id": uuid.uuid4().hex[:8], "title": title[:200], "done": False}
    _save([*tasks, task])
    return task


@mcp.tool()
def complete_task(task_id: str) -> dict:
    """Mark a task as done."""
    tasks = _load()
    for task in tasks:
        if task["id"] == task_id:
            task["done"] = True
            _save(tasks)
            return task
    raise ValueError("task not found")


if __name__ == "__main__":
    mcp.run()
