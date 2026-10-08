"""Entry point: ``python -m axp_runtime``."""

import signal
import threading

import axp_telemetry

from .config import load_settings
from .runtime import Runtime


def main() -> None:
    axp_telemetry.setup("agent-runtime")
    runtime = Runtime(load_settings())
    stopped = threading.Event()

    def stop(*_):
        # Not a daemon: the process exits once the runtime has stopped
        # gracefully (within Docker's 10 s stop timeout).
        def run():
            runtime.shutdown()
            stopped.set()

        threading.Thread(target=run, name="shutdown").start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    threading.Thread(target=runtime.boot, name="boot", daemon=True).start()
    stopped.wait()
    axp_telemetry.shutdown()


if __name__ == "__main__":
    main()
