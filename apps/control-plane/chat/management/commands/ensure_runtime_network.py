from django.core.management.base import BaseCommand

from chat.control.driver import DockerDriver


class Command(BaseCommand):
    help = "Create the Docker network runtimes use to reach the internal API."

    def handle(self, *args, **options):
        DockerDriver().ensure_network()
