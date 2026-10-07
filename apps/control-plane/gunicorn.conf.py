# Loaded by gunicorn from the working directory. Its own logs (worker boots,
# timeouts, crashes) go through OpenTelemetry like the application's.
logconfig_dict = {
    "version": 1,
    "disable_existing_loggers": False,
    "root": {
        "level": "INFO",
        "handlers": ["otel"],
    },
    "loggers": {
        "gunicorn.error": {"level": "INFO", "handlers": [], "propagate": True},
        # Requests are logged at the edge gateway, as before.
        "gunicorn.access": {"level": "WARNING", "handlers": [], "propagate": True},
    },
    "handlers": {
        "otel": {"()": "axp_telemetry.handler", "service": "control-plane"},
    },
}
