import axp_telemetry
from django.apps import AppConfig


class ChatConfig(AppConfig):
    name = "chat"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        # Every process (runserver, gunicorn workers, management commands)
        # logs through OpenTelemetry; see settings.LOGGING.
        axp_telemetry.setup("control-plane")
