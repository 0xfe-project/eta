"""Entry point: ``python -m axp_forge``.

AXP_FORGE_ADDR is the listen address (host:port); AXP_FORGE_STATE_DIR keeps
the GitHub App's credentials.
"""

import os
from pathlib import Path

import axp_telemetry
import uvicorn

from .app import create_app
from .github import GitHub


def main() -> None:
    axp_telemetry.setup("forge-service")
    host, _, port = os.environ.get("AXP_FORGE_ADDR", "0.0.0.0:8330").rpartition(":")
    state = Path(os.environ.get("AXP_FORGE_STATE_DIR", "var/forge"))
    uvicorn.run(
        create_app(GitHub(state)),
        host=host or "0.0.0.0",
        port=int(port),
        log_config=None,
    )
    axp_telemetry.shutdown()


if __name__ == "__main__":
    main()
