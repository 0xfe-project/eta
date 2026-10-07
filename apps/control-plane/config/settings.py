import os
import socket
from pathlib import Path

import dj_database_url
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")
DEBUG = os.getenv("DJANGO_DEBUG", "true").lower() == "true"
SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "")
if not SECRET_KEY:
    if not DEBUG:
        raise RuntimeError("DJANGO_SECRET_KEY is required when DEBUG is false")
    SECRET_KEY = "django-insecure-local-development-only"
ALLOWED_HOSTS = os.getenv("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
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
# PostgreSQL via DATABASE_URL; SQLite remains the zero-config local default.
DATABASES = {
    "default": dj_database_url.config(
        default=f"sqlite:///{BASE_DIR / 'db.sqlite3'}", conn_max_age=60
    )
}
if DATABASES["default"]["ENGINE"] == "django.db.backends.sqlite3":
    # The API server and the runtime worker write concurrently.
    DATABASES["default"]["CONN_MAX_AGE"] = 0
    DATABASES["default"]["OPTIONS"] = {"timeout": 20, "transaction_mode": "IMMEDIATE"}
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True
STATIC_URL = "static/"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

CHAT_MAX_QUEUED_PER_AGENT = int(os.getenv("CHAT_MAX_QUEUED_PER_AGENT", "20"))
CHAT_STREAM_POLL_SECONDS = float(os.getenv("CHAT_STREAM_POLL_SECONDS", "0.5"))
CHAT_STREAM_HEARTBEAT_SECONDS = 15.0

# --- Agent runtime orchestration (internal; see chat/control) ---------------
AXP_HOST_ID = os.getenv("AXP_HOST_ID", socket.gethostname())
AXP_RUNTIME_IMAGE = os.getenv("AXP_RUNTIME_IMAGE", "axp-agent-runtime:dev")
AXP_RUNTIME_NETWORK = os.getenv("AXP_RUNTIME_NETWORK", "axp-runtime")
AXP_RUNTIME_SUBNET = os.getenv("AXP_RUNTIME_SUBNET", "172.30.0.0/24")
# Where runtimes reach the internal API (served by a separate process).
AXP_INTERNAL_URL = os.getenv("AXP_INTERNAL_URL", "http://172.30.0.1:8001")
AXP_RUNTIME_LEASE_SECONDS = float(os.getenv("AXP_RUNTIME_LEASE_SECONDS", "30"))
AXP_RUNTIME_START_TIMEOUT = float(os.getenv("AXP_RUNTIME_START_TIMEOUT", "120"))
AXP_RUNTIME_IDLE_SECONDS = float(os.getenv("AXP_RUNTIME_IDLE_SECONDS", "600"))
AXP_RUNTIME_RETRY_SECONDS = float(os.getenv("AXP_RUNTIME_RETRY_SECONDS", "30"))
AXP_DISPATCH_TIMEOUT = float(os.getenv("AXP_DISPATCH_TIMEOUT", "120"))
AXP_RUNTIME_MEMORY = os.getenv("AXP_RUNTIME_MEMORY", "2g")
AXP_RUNTIME_CPUS = float(os.getenv("AXP_RUNTIME_CPUS", "1"))
# Host environment variables forwarded to runtimes, e.g. model credentials.
AXP_RUNTIME_ENV_PASSTHROUGH = [
    name
    for name in os.getenv("AXP_RUNTIME_ENV_PASSTHROUGH", "OPENAI_API_KEY").split(",")
    if name
]
# Optional Codex auth.json copied into each new agent's state on first start.
AXP_CODEX_AUTH_FILE = os.getenv("AXP_CODEX_AUTH_FILE") or None
# Overrides the Codex command inside runtimes (e.g. the scripted fake server).
AXP_CODEX_LAUNCH = os.getenv("AXP_CODEX_LAUNCH") or None
# Model for agents created without one (falls back to the old name).
AXP_DEFAULT_MODEL = (
    os.getenv("AXP_DEFAULT_MODEL") or os.getenv("AXP_CODEX_MODEL") or None
)
# LLM gateway (apps/llm-gateway). With a URL set, agents need an available
# gateway model to chat and runtimes send every model request to
# AXP_LLM_RUNTIME_BASE_URL with AXP_LLM_API_KEY instead of holding provider
# credentials.
AXP_LLM_GATEWAY_URL = os.getenv("AXP_LLM_GATEWAY_URL", "")
AXP_LLM_RUNTIME_BASE_URL = os.getenv("AXP_LLM_RUNTIME_BASE_URL", "")
AXP_LLM_API_KEY = os.getenv("AXP_LLM_API_KEY", "")
# The per-agent container is the isolation boundary.
AXP_CODEX_SANDBOX = os.getenv("AXP_CODEX_SANDBOX", "danger-full-access")
AXP_CODEX_APPROVAL_POLICY = os.getenv("AXP_CODEX_APPROVAL_POLICY", "on-request")
AXP_WORKSPACE_BACKEND = os.getenv("AXP_WORKSPACE_BACKEND", "volume")
AXP_S3_ENDPOINT = os.getenv("AXP_S3_ENDPOINT", "")
AXP_S3_REGION = os.getenv("AXP_S3_REGION", "us-east-1")
AXP_S3_ACCESS_KEY_ID = os.getenv("AXP_S3_ACCESS_KEY_ID", "")
AXP_S3_SECRET_ACCESS_KEY = os.getenv("AXP_S3_SECRET_ACCESS_KEY", "")
AXP_S3_WORKSPACE_BUCKET = os.getenv("AXP_S3_WORKSPACE_BUCKET", "axp-workspaces")
AXP_OBJECT_STORE = os.getenv("AXP_OBJECT_STORE", "filesystem")
AXP_OBJECT_DIR = Path(os.getenv("AXP_OBJECT_DIR", BASE_DIR / "var" / "objects"))
AXP_S3_CHECKPOINT_BUCKET = os.getenv("AXP_S3_CHECKPOINT_BUCKET", "axp-checkpoints")
AXP_CHECKPOINT_AFTER_TURNS = int(os.getenv("AXP_CHECKPOINT_AFTER_TURNS", "5"))
CHAT_DEFAULT_MCP_MODULES = [
    key for key in os.getenv("CHAT_DEFAULT_MCP_MODULES", "tasks").split(",") if key
]
