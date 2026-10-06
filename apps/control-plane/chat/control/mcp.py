"""MCP module registry and per-agent bindings (RFC §8).

Launch specs come only from trusted deployment tooling. Bindings carry
schema-validated config; secrets are referenced, never stored.
"""

import os

import jsonschema
from django.conf import settings
from django.db import transaction
from django.db.models import F

from ..models import Agent, AgentMcpBinding, McpModuleRevision


class McpConfigError(Exception):
    pass


def validate_launch_spec(spec: dict) -> None:
    if not isinstance(spec, dict) or set(spec) - {"command", "args", "env"}:
        raise McpConfigError("launch_spec allows only command, args and env")
    if not isinstance(spec.get("command"), str) or not spec["command"]:
        raise McpConfigError("launch_spec.command must be a non-empty string")
    if not all(isinstance(arg, str) for arg in spec.get("args", [])):
        raise McpConfigError("launch_spec.args must be strings")
    env = spec.get("env", {})
    if not isinstance(env, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in env.items()
    ):
        raise McpConfigError("launch_spec.env must map strings to strings")


def register_revision(
    module_key: str, revision: str, launch_spec: dict, config_schema: dict
) -> McpModuleRevision:
    """Create an immutable revision; re-registering identical content is a no-op."""
    validate_launch_spec(launch_spec)
    jsonschema.Draft202012Validator.check_schema(config_schema)
    existing = McpModuleRevision.objects.filter(
        module_key=module_key, revision=revision
    ).first()
    if existing:
        if (existing.launch_spec, existing.config_schema) != (
            launch_spec,
            config_schema,
        ):
            raise McpConfigError(f"{module_key}@{revision} exists with other content")
        return existing
    return McpModuleRevision.objects.create(
        module_key=module_key,
        revision=revision,
        launch_spec=launch_spec,
        config_schema=config_schema,
    )


def _validate_binding(revision: McpModuleRevision, config: dict, tools: list) -> None:
    try:
        jsonschema.validate(config, revision.config_schema)
    except jsonschema.ValidationError as exc:
        raise McpConfigError(f"invalid config: {exc.message}") from exc
    if not all(isinstance(tool, str) for tool in tools):
        raise McpConfigError("allowed_tools must be strings")


def bind(
    agent: Agent,
    revision: McpModuleRevision,
    *,
    required: bool = False,
    allowed_tools: list | None = None,
    config: dict | None = None,
    secret_ref: str | None = None,
    enabled: bool = True,
) -> AgentMcpBinding:
    config = config or {}
    allowed_tools = allowed_tools or []
    _validate_binding(revision, config, allowed_tools)
    if secret_ref and not secret_ref.startswith("env:"):
        raise McpConfigError("secret_ref must look like env:NAME")
    with transaction.atomic():
        binding, _ = AgentMcpBinding.objects.update_or_create(
            agent=agent,
            module_key=revision.module_key,
            defaults={
                "module_revision": revision,
                "enabled": enabled,
                "required": required,
                "allowed_tools": allowed_tools,
                "config": config,
                "secret_ref": secret_ref,
            },
        )
        # Running instances keep their snapshot until the next start.
        Agent.objects.filter(pk=agent.pk).update(
            mcp_config_version=F("mcp_config_version") + 1
        )
    return binding


def bind_defaults(agent: Agent) -> None:
    """Bind the deployment's default modules to a new agent."""
    for key in settings.CHAT_DEFAULT_MCP_MODULES:
        revision = (
            McpModuleRevision.objects.filter(module_key=key, enabled=True)
            .order_by("-created_at")
            .first()
        )
        if revision:
            bind(agent, revision)


def snapshot(agent: Agent) -> list[dict]:
    """The immutable MCP configuration for a new runtime instance."""
    modules = []
    bindings = agent.mcp_bindings.filter(
        enabled=True, module_revision__enabled=True
    ).select_related("module_revision")
    for binding in bindings.order_by("module_key"):
        revision = binding.module_revision
        _validate_binding(revision, binding.config, binding.allowed_tools)
        env = dict(revision.launch_spec.get("env", {}))
        if binding.secret_ref:
            env["AXP_MCP_SECRET"] = os.environ.get(binding.secret_ref[4:], "")
        modules.append(
            {
                "module_key": binding.module_key,
                "revision": revision.revision,
                "required": binding.required,
                "allowed_tools": binding.allowed_tools,
                "launch": {
                    "command": revision.launch_spec["command"],
                    "args": revision.launch_spec.get("args", []),
                    "env": env,
                },
                "config": binding.config,
            }
        )
    return modules
