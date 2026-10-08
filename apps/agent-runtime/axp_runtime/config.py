"""Runtime settings, injected by the controller through environment variables."""

import json
import os
import shlex
from dataclasses import dataclass
from pathlib import Path

PROTOCOL_VERSION = "1"


@dataclass(frozen=True)
class Settings:
    agent_id: str
    instance_id: str
    generation: int
    token: str
    # The runtime gateway: the internal API under /internal, the LLM gateway's
    # OpenAI-compatible API (Codex's model provider) under /v1.
    gateway_url: str
    # Everything the agent keeps; its snapshot is exactly this directory.
    home_dir: Path
    known_thread_id: str | None
    model: str | None
    # The agent's description, injected as Codex developer instructions.
    developer_instructions: str = ""
    config_version: int = 0
    # The image's local Codex plugin marketplace, and the names of the ones
    # this agent runs with (all of them when None).
    plugins_dir: Path = Path("/opt/axp/plugins")
    plugins: tuple[str, ...] | None = None
    # Presigned download of the agent's latest snapshot, if it has one.
    snapshot_url: str | None = None
    # Overrides the Codex launch command; used to run a scripted app-server.
    codex_launch: list[str] | None = None
    heartbeat_seconds: float = 5.0
    # Context window of models Codex does not know (e.g. Grok).
    model_context_window: int | None = None
    # The agent queue (NATS JetStream).
    nats_url: str = ""
    # Outside the snapshot: gh logged in as the GitHub App, and git's commit
    # identity in GitHub repositories.
    run_dir: Path = Path("/run/axp")

    @property
    def workspace_dir(self) -> Path:
        return self.home_dir / "workspace"

    @property
    def codex_home(self) -> Path:
        return self.home_dir / "codex"


def _require(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def _json(name: str, default):
    raw = os.environ.get(name)
    return json.loads(raw) if raw else default


def load_settings() -> Settings:
    codex = _json("AXP_CODEX_SETTINGS", {})
    launch = os.environ.get("AXP_CODEX_LAUNCH")
    return Settings(
        agent_id=_require("AXP_AGENT_ID"),
        instance_id=_require("AXP_INSTANCE_ID"),
        generation=int(_require("AXP_GENERATION")),
        token=_require("AXP_RUNTIME_TOKEN"),
        gateway_url=_require("AXP_GATEWAY_URL").rstrip("/"),
        home_dir=Path(os.environ.get("AXP_HOME", "/agent")),
        known_thread_id=os.environ.get("AXP_THREAD_ID") or None,
        model=codex.get("model"),
        developer_instructions=codex.get("developer_instructions") or "",
        config_version=int(os.environ.get("AXP_CONFIG_VERSION", "0")),
        snapshot_url=os.environ.get("AXP_SNAPSHOT_URL") or None,
        plugins_dir=Path(os.environ.get("AXP_PLUGINS_DIR", "/opt/axp/plugins")),
        plugins=tuple(codex["plugins"]) if "plugins" in codex else None,
        codex_launch=shlex.split(launch) if launch else None,
        heartbeat_seconds=float(os.environ.get("AXP_HEARTBEAT_SECONDS", "5")),
        model_context_window=codex.get("model_context_window") or None,
        nats_url=_require("AXP_NATS_URL"),
        run_dir=Path(os.environ.get("AXP_RUN_DIR", "/run/axp")),
    )
