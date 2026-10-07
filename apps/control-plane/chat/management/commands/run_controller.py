import logging
import signal
import threading

from django.core.management.base import BaseCommand
from django.db import connections

from chat.control import objects
from chat.control.controller import Controller
from chat.control.driver import DockerDriver

logger = logging.getLogger(__name__)

# pg_advisory_lock key; any constant shared by all controllers works.
CONTROLLER_LOCK_KEY = 0x41585043


class Command(BaseCommand):
    help = "Run the agent runtime controller (Docker)."

    def add_arguments(self, parser):
        parser.add_argument("--interval", type=float, default=0.5)

    def handle(self, *args, interval, **options):
        # As a container's PID 1 the process ignores SIGTERM unless it handles
        # it; without this, every deploy waits out the stop timeout.
        stop = threading.Event()
        for signum in (signal.SIGTERM, signal.SIGINT):
            signal.signal(signum, lambda *_: stop.set())
        # Deploys briefly run the old and new controller side by side. A
        # session lock on a dedicated connection makes the new one wait until
        # the old one exits.
        lock = connections.create_connection("default")
        logger.info("Waiting for the controller lock")
        with lock.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_lock(%s)", [CONTROLLER_LOCK_KEY])
        driver = DockerDriver()
        driver.ensure_network()
        driver.ensure_storage()
        objects.ensure_bucket()
        Controller(driver).run_forever(interval=interval, stop=stop)
