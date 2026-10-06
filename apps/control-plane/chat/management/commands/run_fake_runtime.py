import logging

from django.core.management.base import BaseCommand

from chat.fake_runtime import FakeRuntime


class Command(BaseCommand):
    help = "Process queued chat commands with the development fake runtime."

    def add_arguments(self, parser):
        parser.add_argument("--concurrency", type=int, default=4)
        parser.add_argument("--step-delay", type=float, default=0.4)

    def handle(self, *args, concurrency, step_delay, **options):
        logging.basicConfig(level=logging.INFO)
        FakeRuntime(step_delay=step_delay).run_forever(concurrency=concurrency)
