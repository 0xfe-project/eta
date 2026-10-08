"""The runtime image's Codex plugins, which agents choose from.

The catalog is the image's local marketplace (apps/agent-runtime/plugins):
``.agents/plugins/marketplace.json`` lists the plugins, each described by its
``.codex-plugin/plugin.json``. Runtimes install the chosen ones at start.
"""

import json
from functools import cache

from django.conf import settings

from .errors import ApiError


@cache
def catalog() -> list[dict]:
    """``[{name, description}]`` in marketplace order."""
    root = settings.AXP_PLUGINS_DIR
    marketplace = json.loads(
        (root / ".agents" / "plugins" / "marketplace.json").read_text()
    )
    plugins = []
    for entry in marketplace["plugins"]:
        manifest = root / entry["source"]["path"] / ".codex-plugin" / "plugin.json"
        plugins.append(
            {
                "name": entry["name"],
                "description": json.loads(manifest.read_text()).get("description", ""),
            }
        )
    return plugins


def choose(names: list[str] | None) -> list[str]:
    """The plugins an agent runs with, in catalog order; all when ``None``."""
    known = [plugin["name"] for plugin in catalog()]
    if names is None:
        return known
    unknown = set(names) - set(known)
    if unknown:
        raise ApiError(
            422, "PLUGIN_NOT_FOUND", f"插件不存在：{'、'.join(sorted(unknown))}。"
        )
    return [name for name in known if name in names]
