"""Scripted stand-in for ``codex app-server`` (JSON-RPC over stdio).

Used by tests and by credential-free end-to-end runs. Behaviour is selected by
markers in the user's text:

  [approve]  ask for command approval before answering
  [slow]     stream slowly so the turn can be interrupted
  [fail]     finish the turn as failed
  [crash]    exit the process after the turn starts

Threads persist under CODEX_HOME so resume works across restarts. MCP servers
passed as ``--config mcp_servers.<name>.command=...`` report ready, unless the
name is listed in FAKE_MCP_FAIL.
"""

import json
import os
import sys
import threading
import time
import uuid
from pathlib import Path

HOME = Path(os.environ.get("CODEX_HOME", "."))
STORE = HOME / "fake_threads.json"
_write_lock = threading.Lock()
_pending: dict[str, dict] = {}
_pending_cond = threading.Condition()
_interrupts: set[str] = set()


def send(message: dict) -> None:
    with _write_lock:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def notify(method: str, params: dict) -> None:
    send({"method": method, "params": params})


def load() -> dict:
    try:
        return json.loads(STORE.read_text())
    except (FileNotFoundError, ValueError):
        return {}


def save(threads: dict) -> None:
    HOME.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(threads))
    tmp.replace(STORE)


def mcp_servers() -> list[str]:
    names = []
    args = sys.argv[1:]
    for index, arg in enumerate(args):
        if arg in ("--config", "-c") and index + 1 < len(args):
            key = args[index + 1].split("=", 1)[0]
            parts = key.split(".")
            if len(parts) == 3 and parts[0] == "mcp_servers" and parts[2] == "command":
                names.append(parts[1])
    return names


def report_mcp(thread_id: str) -> None:
    failing = set(filter(None, os.environ.get("FAKE_MCP_FAIL", "").split(",")))
    for name in mcp_servers():
        status = "failed" if name in failing else "ready"
        notify(
            "mcpServer/startupStatus/updated",
            {"name": name, "status": status, "threadId": thread_id},
        )


def server_request(method: str, params: dict) -> dict:
    request_id = f"srv-{uuid.uuid4().hex[:8]}"
    send({"id": request_id, "method": method, "params": params})
    with _pending_cond:
        while request_id not in _pending:
            _pending_cond.wait()
        return _pending.pop(request_id)


def set_turn(thread_id: str, turn: dict) -> None:
    threads = load()
    turns = threads[thread_id]["turns"]
    for index, existing in enumerate(turns):
        if existing["id"] == turn["id"]:
            turns[index] = turn
            break
    else:
        turns.append(turn)
    save(threads)


def stream_message(thread_id, turn_id, text, delay) -> bool:
    item_id = f"msg-{uuid.uuid4().hex[:8]}"
    item = {"id": item_id, "type": "agentMessage", "text": ""}
    base = {"threadId": thread_id, "turnId": turn_id}
    notify("item/started", {**base, "item": item, "startedAtMs": 0})
    for start in range(0, len(text), 4):
        if turn_id in _interrupts:
            return False
        notify(
            "item/agentMessage/delta",
            {**base, "itemId": item_id, "delta": text[start : start + 4]},
        )
        time.sleep(delay)
    item["text"] = text
    notify("item/completed", {**base, "item": item, "completedAtMs": 0})
    return True


def run_turn(thread_id: str, turn_id: str, text: str) -> None:
    base = {"threadId": thread_id, "turnId": turn_id}
    turn = {"id": turn_id, "items": [], "status": "inProgress"}
    set_turn(thread_id, turn)
    notify("turn/started", {"threadId": thread_id, "turn": turn})
    if "[crash]" in text:
        time.sleep(0.2)
        os._exit(1)
    status = "completed"
    if "[approve]" in text:
        item_id = f"cmd-{uuid.uuid4().hex[:8]}"
        command = {
            "id": item_id,
            "type": "commandExecution",
            "command": "touch approved.txt",
            "commandActions": [],
            "cwd": "/workspace",
            "status": "inProgress",
        }
        notify("item/started", {**base, "item": command, "startedAtMs": 0})
        answer = server_request(
            "item/commandExecution/requestApproval",
            {
                **base,
                "itemId": item_id,
                "startedAtMs": 0,
                "command": "touch approved.txt",
                "reason": "需要创建文件",
            },
        )
        decision = answer.get("decision")
        command["status"] = "completed" if decision == "accept" else "declined"
        notify("item/completed", {**base, "item": command, "completedAtMs": 0})
        if decision == "cancel":
            status = "interrupted"
        reply = "已执行命令。" if decision == "accept" else "已取消该命令。"
    else:
        reply = f"收到：{text}"
    if status == "completed":
        delay = 0.3 if "[slow]" in text else 0.01
        if not stream_message(
            thread_id, turn_id, reply * (10 if "[slow]" in text else 1), delay
        ):
            status = "interrupted"
    if "[fail]" in text:
        status = "failed"
    turn = {"id": turn_id, "items": [], "status": status}
    if status == "failed":
        turn["error"] = {"message": "scripted failure"}
    set_turn(thread_id, turn)
    notify("turn/completed", {"threadId": thread_id, "turn": turn})


def handle(message: dict) -> None:
    method, params, request_id = (
        message.get("method"),
        message.get("params") or {},
        message.get("id"),
    )

    def reply(result=None, error=None):
        if request_id is None:
            return
        body = {"id": request_id}
        body.update({"error": error} if error else {"result": result or {}})
        send(body)

    if method == "initialize":
        return reply(
            {
                "userAgent": "fake-codex/0.160.1",
                "serverInfo": {"name": "fake", "version": "0.160.1"},
            }
        )
    if method == "account/login/start":
        return reply({"type": "apiKey"})
    if method == "thread/start":
        thread_id = str(uuid.uuid4())
        threads = load()
        threads[thread_id] = {
            "turns": [],
            "instructions": params.get("developerInstructions"),
        }
        save(threads)
        reply({"thread": {"id": thread_id}})
        return report_mcp(thread_id)
    if method == "thread/resume":
        thread_id = params.get("threadId")
        threads = load()
        if thread_id not in threads:
            return reply(error={"code": -32600, "message": "thread not found"})
        # Resume applies the current instructions, as Codex does.
        threads[thread_id]["instructions"] = params.get("developerInstructions")
        save(threads)
        reply({"thread": {"id": thread_id}})
        return report_mcp(thread_id)
    if method == "thread/read":
        thread = load().get(params.get("threadId"))
        if thread is None:
            return reply(error={"code": -32600, "message": "thread not found"})
        return reply({"thread": {"id": params["threadId"], "turns": thread["turns"]}})
    if method == "turn/start":
        thread_id = params["threadId"]
        text = "".join(i.get("text", "") for i in params.get("input") or [])
        turn_id = str(uuid.uuid4())
        reply({"turn": {"id": turn_id, "items": [], "status": "inProgress"}})
        threading.Thread(
            target=run_turn, args=(thread_id, turn_id, text), daemon=True
        ).start()
        return
    if method == "turn/interrupt":
        _interrupts.add(params.get("turnId"))
        return reply({})
    if method is None and request_id is not None:
        return  # response to a server request; handled by the reader
    reply({})


def main() -> None:
    for line in sys.stdin:
        if not line.strip():
            continue
        message = json.loads(line)
        if "method" not in message and "id" in message:
            with _pending_cond:
                _pending[message["id"]] = message.get("result") or {}
                _pending_cond.notify_all()
            continue
        handle(message)


if __name__ == "__main__":
    main()
