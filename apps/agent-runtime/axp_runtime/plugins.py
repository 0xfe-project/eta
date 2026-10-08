"""Builds the image's plugins: ``python plugins.py <plugins> <codex config>``.

A plugin is a directory of ``plugins/``: a Codex plugin
(``.codex-plugin/plugin.json``, and optionally ``.mcp.json``, ``skills/`` and
``hooks/hooks.json``) plus, when it needs more than Python, an executable
``setup`` that prepares its environment. Building the runtime image
(Dockerfile) runs this once:

- every plugin's ``setup``, as root, from its directory, with ``TARGETARCH``
  and ``AXP_PLUGIN_CACHE`` (a directory kept across builds, for downloads).
  It installs what the plugin needs (a release binary, apt or Python
  packages) outside the plugin's directory, which is copied into each agent's
  Codex home at start, and checks that it works;
- the local marketplace ``axp`` Codex installs the plugins from;
- in the Codex configuration: approval of every plugin MCP server's tools
  (``config.toml``), and the plugins' hooks as managed hooks
  (``requirements.toml``). Codex only runs plugin hooks a person has
  trusted; managed hooks run by policy, but for every agent, so each runs
  only where its plugin is installed.

Stdlib only: it runs before the runtime's code is in the image.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

MARKETPLACE = "axp"
# Where the image keeps the plugins; hooks run from there.
IMAGE_ROOT = Path("/opt/axp/plugins")
# Codex's names for the plugin directory in hook commands.
ROOT_VARIABLES = ("${PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}")


def plugins(root: Path) -> list[Path]:
    """The plugin directories, by name."""
    return sorted(
        path.parent.parent for path in root.glob("*/.codex-plugin/plugin.json")
    )


def setup(root: Path, cache: Path) -> None:
    for plugin in plugins(root):
        script = plugin / "setup"
        if not script.exists():
            continue
        print(f"Setting up plugin {plugin.name}", flush=True)
        (cache / plugin.name).mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [str(script)],
            cwd=plugin,
            env={
                **os.environ,
                "PLUGIN_ROOT": str(plugin),
                "AXP_PLUGIN_CACHE": str(cache / plugin.name),
            },
            check=True,
        )


def write_marketplace(root: Path) -> None:
    catalog = {
        "name": MARKETPLACE,
        "interface": {"displayName": "AXP"},
        "plugins": [
            {
                "name": plugin.name,
                "source": {"source": "local", "path": f"./{plugin.name}"},
                "policy": {
                    "installation": "AVAILABLE",
                    "authentication": "ON_INSTALL",
                },
                "category": "Productivity",
            }
            for plugin in plugins(root)
        ],
    }
    path = root / ".agents" / "plugins" / "marketplace.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(catalog, indent=2) + "\n")


def tool_approvals(root: Path) -> str:
    """config.toml tables approving every plugin MCP server's tools."""
    tables = []
    for plugin in plugins(root):
        mcp = plugin / ".mcp.json"
        if not mcp.exists():
            continue
        for server in json.loads(mcp.read_text())["mcpServers"]:
            plugin_id = json.dumps(f"{plugin.name}@{MARKETPLACE}")
            tables.append(
                f"[plugins.{plugin_id}.mcp_servers.{json.dumps(server)}]\n"
                'default_tools_approval_mode = "approve"\n'
            )
    return "\n".join(tables)


def managed_hooks(root: Path) -> str:
    """requirements.toml tables declaring the plugins' hooks."""
    tables = []
    for plugin in plugins(root):
        path = plugin / "hooks" / "hooks.json"
        if not path.exists():
            continue
        installed = f'"$CODEX_HOME/plugins/cache/{MARKETPLACE}/{plugin.name}"'
        for event, groups in json.loads(path.read_text())["hooks"].items():
            for group in groups:
                lines = [f"[[hooks.{event}]]"]
                if "matcher" in group:
                    lines.append(f"matcher = {json.dumps(group['matcher'])}")
                for handler in group["hooks"]:
                    lines.append(f"[[hooks.{event}.hooks]]")
                    for key, value in handler.items():
                        if key == "command":
                            for variable in ROOT_VARIABLES:
                                value = value.replace(
                                    variable, str(IMAGE_ROOT / plugin.name)
                                )
                            value = f"if [ -d {installed} ]; then {value}; fi"
                        lines.append(f"{key} = {json.dumps(value)}")
                tables.append("\n".join(lines) + "\n")
    return "\n".join(tables)


def build(root: Path, codex: Path, cache: Path) -> None:
    setup(root, cache)
    write_marketplace(root)
    for name, tables, heading in (
        ("config.toml", tool_approvals(root), "The plugins' tools need no approval."),
        ("requirements.toml", managed_hooks(root), "The plugins' hooks."),
    ):
        if tables:
            with (codex / name).open("a") as file:
                file.write(f"\n# {heading} (generated from plugins/)\n{tables}")


if __name__ == "__main__":
    build(
        Path(sys.argv[1]),
        Path(sys.argv[2]),
        Path(os.environ.get("AXP_PLUGIN_CACHE", "/var/cache/axp-plugins")),
    )
