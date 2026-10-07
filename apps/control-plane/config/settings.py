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
# Every request arrives through the edge gateway or on the runtime network.
ALLOWED_HOSTS = ["*"]
INSTALLED_APPS = [
    "django.contrib.staticfiles",
    "ninja",
    "chat",
]
MIDDLEWARE = [
    "chat.middleware.RequestIdMiddleware",
    "chat.middleware.EdgeSecretMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
# Shared with the edge gateway; public requests without it are rejected.
AXP_EDGE_SECRET = os.getenv("AXP_EDGE_SECRET", "")
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
# addresses on the runtime network's gateway, 172.30.0.1) and production's
# (Kamal network aliases); scripts/dev.sh sets the ones that move with its
# port block, deploy/deploy.yml the production credentials.
# Where runtimes reach the internal API (served by a separate process).
AXP_INTERNAL_URL = os.getenv(
    "AXP_INTERNAL_URL",
    "http://172.30.0.1:8001" if DEBUG else "http://axp-internal:8001",
)
# The LLM gateway (apps/llm-gateway). Runtimes send every model request
# there; the control plane reads its model catalog.
AXP_LLM_GATEWAY_URL = os.getenv(
    "AXP_LLM_GATEWAY_URL", "http://172.30.0.1:8317" if DEBUG else "http://axp-llm:8317"
)
# SeaweedFS's S3 API: JuiceFS keeps workspace data there, checkpoints are
# objects. Runtimes reach it at the same address.
AXP_S3_ENDPOINT = os.getenv(
    "AXP_S3_ENDPOINT", "http://172.30.0.1:8333" if DEBUG else "http://axp-s3:8333"
)
AXP_S3_ACCESS_KEY_ID = os.getenv("AXP_S3_ACCESS_KEY_ID", "axp-dev" if DEBUG else "")
AXP_S3_SECRET_ACCESS_KEY = os.getenv(
    "AXP_S3_SECRET_ACCESS_KEY", "axp-dev-secret" if DEBUG else ""
)
# JuiceFS metadata (Redis on the runtime network).
AXP_JUICEFS_META_URL = os.getenv(
    "AXP_JUICEFS_META_URL", "redis://axp-dev-juicefs-meta:6379/1" if DEBUG else ""
)
# Test hook: runtimes run this instead of the Codex app-server.
AXP_CODEX_LAUNCH = os.getenv("AXP_CODEX_LAUNCH") or None
