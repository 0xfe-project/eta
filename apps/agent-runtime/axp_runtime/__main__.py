"""Entry point: ``python -m axp_runtime``."""

import signal
import threading

import axp_telemetry

from .config import load_settings
from .runtime import Runtime
from .server import serve


def main() -> None:
    axp_telemetry.setup("agent-runtime")
    settings = load_settings()
    runtime = Runtime(settings)
    server = serve(runtime)

    def stop(*_):
        # Not a daemon: the process exits once the runtime has stopped
        # gracefully (within Docker's 10 s stop timeout).
        def run():
            runtime.shutdown()
            server.shutdown()

        threading.Thread(target=run, name="shutdown").start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    # Serve status requests while booting so the controller can observe it.
    threading.Thread(target=runtime.boot, name="boot", daemon=True).start()
    server.serve_forever()
    server.server_close()
    axp_telemetry.shutdown()


if __name__ == "__main__":
    main()
