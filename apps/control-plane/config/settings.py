import os
import secrets
from pathlib import Path

import dj_database_url
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")
# Only scripts/dev.sh turns this on.
DEBUG = os.getenv("DJANGO_DEBUG", "false").lower() == "true"


def _local_secret_key() -> str:
    """A key generated once per checkout, for runs without DJANGO_SECRET_KEY."""
    path = BASE_DIR / "var" / "secret_key"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(mode=0o600)
        path.write_text(secrets.token_hex(32))
    return path.read_text().strip()


# Production sets it (deploy/deploy.sh generates one); runtime tokens derive
# from it, so every control plane process must share it.
SECRET_KEY = os.getenv("DJANGO_SECRET_KEY") or _local_secret_key()
# Every request arrives through the gateway.
ALLOWED_HOSTS = ["*"]
INSTALLED_APPS = [
    "django.contrib.staticfiles",
    "ninja",
    "chat",
]
MIDDLEWARE = [
    "chat.middleware.RequestIdMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
# The internal runtime API runs as a separate process with its own URLconf.
ROOT_URLCONF = os.getenv("AXP_URLCONF", "config.urls")
# Records go through OpenTelemetry from the root logger (axp_telemetry, set up
# in chat.apps). Django's own loggers hand theirs up instead of printing.
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "loggers": {
        name: {"handlers": [], "level": "INFO", "propagate": True}
        for name in ("django", "django.server")
    },
}
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": ["django.template.context_processors.request"]
        },
    }
]
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"
# Defaults to development's axp-dev-postgres (scripts/dev-postgres.sh).
DATABASES = {
    "default": dj_database_url.config(
        default="postgres://axp:axp@127.0.0.1:15432/axp", conn_max_age=60
    )
}
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True
STATIC_URL = "static/"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# Service addresses and credentials. The defaults are development's (fixed
# addresses on the runtime network's gateway, 172.30.0.1, or loopback) and
# production's (Kamal network aliases); scripts/dev.sh sets the ones that move
# with its port block, deploy/deploy.yml the production credentials.
# The runtime gateway (apps/gateway): runtimes' only route to the internal API
# and the LLM gateway.
AXP_RUNTIME_GATEWAY_URL = os.getenv(
    "AXP_RUNTIME_GATEWAY_URL",
    "http://172.30.0.1:8090" if DEBUG else "http://axp-runtime-gateway:8090",
)
# The LLM gateway (apps/llm-gateway), for its model catalog.
AXP_LLM_GATEWAY_URL = os.getenv(
    "AXP_LLM_GATEWAY_URL", "http://127.0.0.1:8317" if DEBUG else "http://axp-llm:8317"
)
# SeaweedFS's S3 API, holding agent snapshots. Runtimes reach it at the same
# address through presigned URLs.
AXP_S3_ENDPOINT = os.getenv(
    "AXP_S3_ENDPOINT", "http://172.30.0.1:8333" if DEBUG else "http://axp-s3:8333"
)
AXP_S3_ACCESS_KEY_ID = os.getenv("AXP_S3_ACCESS_KEY_ID", "axp-dev" if DEBUG else "")
AXP_S3_SECRET_ACCESS_KEY = os.getenv(
    "AXP_S3_SECRET_ACCESS_KEY", "axp-dev-secret" if DEBUG else ""
)
# NATS JetStream, the agent queue (chat/queue.py). Runtimes reach it at the same
# address.
AXP_NATS_URL = os.getenv(
    "AXP_NATS_URL", "nats://172.30.0.1:4222" if DEBUG else "nats://axp-nats:4222"
)
# The runtime image's Codex plugins (apps/agent-runtime/plugins), for the
# catalog agents choose from; the production image copies them alongside.
AXP_PLUGINS_DIR = Path(
    os.getenv("AXP_PLUGINS_DIR", BASE_DIR.parent / "agent-runtime" / "plugins")
)
# Test hook: runtimes run this instead of the Codex app-server.
AXP_CODEX_LAUNCH = os.getenv("AXP_CODEX_LAUNCH") or None
