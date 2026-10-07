"""OpenTelemetry setup shared by AXP's Python services.

Services log through the standard ``logging`` module. Every record goes
through the OpenTelemetry log pipeline to two exporters: a readable line on
stderr and OTLP, to OTEL_EXPORTER_OTLP_ENDPOINT or
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT (unset only in tests). Everything else uses
the standard OTEL_* variables. Records logged inside a span carry its trace
once tracing is added.
"""

import logging
import os
import sys
import threading

from opentelemetry._logs import set_logger_provider
from opentelemetry.instrumentation.logging.handler import LoggingHandler
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import (
    BatchLogRecordProcessor,
    SimpleLogRecordProcessor,
)
from opentelemetry.sdk.resources import SERVICE_NAME, Resource

from .console import ConsoleExporter

__all__ = ["handler", "setup", "shutdown"]

_provider: LoggerProvider | None = None
_handler: logging.Handler | None = None


def handler(service: str) -> logging.Handler:
    """The OpenTelemetry logging handler for ``service``, created once.

    Usable from logging.config.dictConfig as ``{"()": "axp_telemetry.handler",
    "service": ...}``. OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES override
    the defaults.
    """
    global _provider, _handler
    if _handler is not None:
        return _handler
    # Attributes passed to Resource.create win over the environment, so the
    # default name only applies without OTEL_SERVICE_NAME (as in Go and JS).
    name = os.environ.get("OTEL_SERVICE_NAME") or service
    provider = LoggerProvider(resource=Resource.create({SERVICE_NAME: name}))
    provider.add_log_record_processor(SimpleLogRecordProcessor(ConsoleExporter()))
    if os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or os.environ.get(
        "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"
    ):
        from opentelemetry.exporter.otlp.proto.http._log_exporter import (
            OTLPLogExporter,
        )

        provider.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter()))
    set_logger_provider(provider)

    # The SDK reports its own problems through logging; keep those out of the
    # pipeline they are about.
    sdk_logger = logging.getLogger("opentelemetry")
    sdk_logger.propagate = False
    sdk_logger.addHandler(logging.StreamHandler())

    _handler = LoggingHandler(logger_provider=provider)
    _handler.addFilter(_keep_valid_attributes)
    _provider = provider
    return _handler


def setup(service: str) -> None:
    """Route the root logger through OpenTelemetry for ``service``.

    A no-op when the root logger already uses the handler (for example when
    gunicorn configured logging before Django loaded).
    """
    otel = handler(service)
    root = logging.getLogger()
    if otel in root.handlers:
        return
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(otel)
    root.setLevel(logging.INFO)
    _log_uncaught_exceptions()


def _log_uncaught_exceptions() -> None:
    """Log uncaught exceptions (main and other threads) instead of printing."""
    logger = logging.getLogger("axp.uncaught")

    def excepthook(exc_type, exc, tb):
        logger.critical("uncaught exception", exc_info=(exc_type, exc, tb))

    def thread_excepthook(args):
        if args.exc_type is SystemExit:
            return
        name = args.thread.name if args.thread else "?"
        logger.error(
            "uncaught exception in thread %s",
            name,
            exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
        )

    sys.excepthook = excepthook
    threading.excepthook = thread_excepthook


# Attributes of every LogRecord; the rest came from ``extra``.
_STANDARD = set(vars(logging.makeLogRecord({}))) | {"message", "asctime"}
_PRIMITIVES = (str, bool, int, float)


def _keep_valid_attributes(record: logging.LogRecord) -> bool:
    """Drop ``extra`` values OpenTelemetry attributes cannot hold.

    Libraries attach objects (Django adds the request and its socket); only
    primitives and sequences of them are valid attribute values.
    """
    for key, value in list(vars(record).items()):
        if key in _STANDARD:
            continue
        valid = isinstance(value, _PRIMITIVES) or (
            isinstance(value, (list, tuple))
            and all(isinstance(item, _PRIMITIVES) for item in value)
        )
        if not valid:
            delattr(record, key)
    return True


def shutdown() -> None:
    """Flush pending records; call before the process exits."""
    if _provider is not None:
        _provider.shutdown()
