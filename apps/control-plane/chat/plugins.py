"""The runtime image's Codex plugins, which agents choose from.

The catalog is the directories of apps/agent-runtime/plugins, each a plugin
described by its ``.codex-plugin/plugin.json``; building the runtime image
makes them a marketplace in the same order (axp_runtime/plugins.py).
Runtimes install the chosen ones at start.
"""

import json
from functools import cache

from django.conf import settings

from .errors import ApiError


@cache
def catalog() -> list[dict]:
    """``[{name, description}]`` by name."""
    manifests = sorted(settings.AXP_PLUGINS_DIR.glob("*/.codex-plugin/plugin.json"))
    return [
        {
            "name": manifest.parent.parent.name,
            "description": json.loads(manifest.read_text()).get("description", ""),
        }
        for manifest in manifests
    ]


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
