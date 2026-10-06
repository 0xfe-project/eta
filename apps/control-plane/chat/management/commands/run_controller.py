import logging

from django.core.management.base import BaseCommand

from chat.control.controller import Controller
from chat.control.driver import DockerDriver


class Command(BaseCommand):
    help = "Run the agent runtime controller (Docker)."

    def add_arguments(self, parser):
        parser.add_argument("--interval", type=float, default=0.5)

    def handle(self, *args, interval, **options):
        logging.basicConfig(level=logging.INFO)
        driver = DockerDriver()
        driver.ensure_network()
        Controller(driver).run_forever(interval=interval)
