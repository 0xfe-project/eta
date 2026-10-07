"""Runtime settings, injected by the controller through environment variables."""

import json
import os
import shlex
from dataclasses import dataclass, field
from pathlib import Path

PROTOCOL_VERSION = "1"


@dataclass(frozen=True)
class McpModule:
    module_key: str
    revision: str
    required: bool
    allowed_tools: list[str]
    command: str
    args: list[str]
    env: dict[str, str]
    config: dict


@dataclass(frozen=True)
class Settings:
    agent_id: str
    instance_id: str
    generation: int
    token: str
    control_plane_url: str
    listen_host: str
    listen_port: int
    # Everything the agent keeps; its snapshot is exactly this directory.
    home_dir: Path
    known_thread_id: str | None
    model: str | None
    sandbox: str
    approval_policy: str
    # OpenAI-compatible endpoint of the LLM gateway, Codex's model provider.
    llm_base_url: str
    # The agent's description, injected as Codex developer instructions.
    developer_instructions: str = ""
    mcp_modules: list[McpModule] = field(default_factory=list)
    config_version: int = 0
    # Presigned download of the agent's latest snapshot, if it has one.
    snapshot_url: str | None = None
    # Overrides the Codex launch command; used to run a scripted app-server.
    codex_launch: list[str] | None = None
    heartbeat_seconds: float = 5.0
    mcp_ready_timeout: float = 30.0
    # Context window of models Codex does not know (e.g. Grok).
    model_context_window: int | None = None

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
    modules = [
        McpModule(
            module_key=item["module_key"],
            revision=str(item["revision"]),
            required=bool(item.get("required", False)),
            allowed_tools=list(item.get("allowed_tools") or []),
            command=item["launch"]["command"],
            args=list(item["launch"].get("args") or []),
            env=dict(item["launch"].get("env") or {}),
            config=dict(item.get("config") or {}),
        )
        for item in _json("AXP_MCP_SNAPSHOT", [])
    ]
    launch = os.environ.get("AXP_CODEX_LAUNCH")
    return Settings(
        agent_id=_require("AXP_AGENT_ID"),
        instance_id=_require("AXP_INSTANCE_ID"),
        generation=int(_require("AXP_GENERATION")),
        token=_require("AXP_RUNTIME_TOKEN"),
        control_plane_url=_require("AXP_CONTROL_PLANE_URL").rstrip("/"),
        listen_host=os.environ.get("AXP_LISTEN_HOST", "0.0.0.0"),
        listen_port=int(os.environ.get("AXP_LISTEN_PORT", "8080")),
        home_dir=Path(os.environ.get("AXP_HOME", "/agent")),
        known_thread_id=os.environ.get("AXP_THREAD_ID") or None,
        model=codex.get("model"),
        sandbox=codex.get("sandbox", "workspace-write"),
        approval_policy=codex.get("approval_policy", "on-request"),
        developer_instructions=codex.get("developer_instructions") or "",
        mcp_modules=modules,
        config_version=int(os.environ.get("AXP_CONFIG_VERSION", "0")),
        snapshot_url=os.environ.get("AXP_SNAPSHOT_URL") or None,
        codex_launch=shlex.split(launch) if launch else None,
        heartbeat_seconds=float(os.environ.get("AXP_HEARTBEAT_SECONDS", "5")),
        mcp_ready_timeout=float(os.environ.get("AXP_MCP_READY_TIMEOUT", "30")),
        llm_base_url=_require("AXP_LLM_BASE_URL"),
        model_context_window=codex.get("model_context_window") or None,
    )
