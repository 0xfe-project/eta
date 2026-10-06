"""Entry point: ``python -m axp_runtime``."""

import logging
import signal
import threading

from .config import load_settings
from .runtime import Runtime
from .server import serve


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )
    settings = load_settings()
    runtime = Runtime(settings)
    server = serve(runtime)

    def stop(*_):
        runtime.shutdown()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    # Serve status requests while booting so the controller can observe it.
    threading.Thread(target=runtime.boot, name="boot", daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
