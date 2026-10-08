"""The memory plugin's hooks: ``memory.py recall`` and ``memory.py capture``.

They are declared in the image's managed Codex requirements
(codex/requirements.toml), not in the plugin, so they run without review, and
for every agent: they do nothing where the plugin is not installed.

recall (UserPromptSubmit) adds the memories relevant to the prompt to the
turn's context. capture (Stop) sends the finished turn, its prompts and final
answer, to be remembered. Both go to the memory service through the runtime
gateway with the runtime's key, and never hold up the turn: on any failure
they do nothing.
"""

import json
import os
import sys
import time
import urllib.request
from pathlib import Path

TIMEOUT = 3
# Prompts of turns that never finished (interrupted, or the runtime stopped).
STALE_SECONDS = 24 * 3600


def post(path: str, body: dict) -> bytes:
    request = urllib.request.Request(
        os.environ["AXP_GATEWAY_URL"] + path,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {os.environ['AXP_RUNTIME_LLM_KEY']}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return response.read()


def installed() -> bool:
    return (Path(os.environ["CODEX_HOME"]) / "plugins/cache/axp/memory").is_dir()


def pending(turn_id: str) -> Path:
    """The turn's prompts, kept from recall until capture."""
    directory = Path(os.environ["CODEX_HOME"]) / "axp-memory" / "turns"
    directory.mkdir(parents=True, exist_ok=True)
    for stale in directory.glob("*.json"):
        if stale.stat().st_mtime < time.time() - STALE_SECONDS:
            stale.unlink(missing_ok=True)
    return directory / f"{Path(turn_id).name}.json"


def recall(event: dict) -> dict:
    prompt = event.get("prompt") or ""
    # Steers add prompts to a running turn; the turn keeps them all.
    path = pending(event["turn_id"])
    prompts = json.loads(path.read_text()) if path.exists() else []
    path.write_text(json.dumps([*prompts, prompt]))
    memories = json.loads(post("/memory/recall", {"query": prompt}))["memories"]
    if not memories:
        return {}
    lines = [f"- {m['text']} (memory {m['id']})" for m in memories]
    context = "\n".join(
        [
            "Memories from earlier conversations that may be relevant. They "
            "can be outdated; forget the ones that turn out wrong.",
            *lines,
        ]
    )
    return {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": context,
        }
    }


def capture(event: dict) -> dict:
    path = pending(event["turn_id"])
    if not path.exists():
        return {}  # not a turn with a prompt, e.g. compaction
    prompts = json.loads(path.read_text())
    path.unlink()
    messages = [{"role": "user", "content": p} for p in prompts if p]
    if answer := event.get("last_assistant_message"):
        messages.append({"role": "assistant", "content": answer})
    if messages:
        post("/memory/capture", {"model": event.get("model"), "messages": messages})
    return {}


def main() -> None:
    output = {}
    try:
        event = json.load(sys.stdin)
        if installed():
            output = {"recall": recall, "capture": capture}[sys.argv[1]](event)
    except Exception as exc:
        print(f"memory hook skipped: {exc}", file=sys.stderr)
    print(json.dumps(output))


if __name__ == "__main__":
    main()
