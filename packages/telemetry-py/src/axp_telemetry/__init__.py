"""OpenTelemetry setup shared by AXP's Python services.

Services log through the standard ``logging`` module. Every record goes
through the OpenTelemetry log pipeline to two exporters: a readable line on
stderr and OTLP, to OTEL_EXPORTER_OTLP_ENDPOINT or
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT (unset only in tests). Everything else uses
the standard OTEL_* variables. Records logged inside a span carry its trace
once tracing is added.
"""

import fnmatch
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
from opentelemetry.sdk.resources import SERVICE_NAME, SERVICE_VERSION, Resource

from .console import ConsoleExporter

__all__ = ["handler", "setup", "shutdown"]

_provider: LoggerProvider | None = None
_handler: logging.Handler | None = None
# GET paths whose successful requests are not logged (see setup).
_quiet: tuple[str, ...] = ()


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
    attributes = {SERVICE_NAME: name}
    # Kamal sets the deployed version (its git commit) in every container.
    if version := os.environ.get("KAMAL_VERSION"):
        attributes[SERVICE_VERSION] = version
    provider = LoggerProvider(resource=Resource.create(attributes))
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
    _handler.addFilter(_skip_successful_reads)
    _provider = provider
    return _handler


def setup(service: str, quiet: tuple[str, ...] = ()) -> None:
    """Route the root logger through OpenTelemetry for ``service``.

    Successful GETs of a ``quiet`` path (an fnmatch pattern: health checks,
    polling) are left out of uvicorn's access log.

    A no-op when the root logger already uses the handler (for example when
    a server configured logging before the application loaded).
    """
    global _quiet
    _quiet = quiet
    otel = handler(service)
    root = logging.getLogger()
    if otel in root.handlers:
        return
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(otel)
    root.setLevel(logging.INFO)
    # One record per outgoing request (the LLM gateway's calls) says nothing
    # the caller does not log itself.
    logging.getLogger("httpx").setLevel(logging.WARNING)
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

    Libraries attach objects (web frameworks add the request and its socket); only
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


def _skip_successful_reads(record: logging.LogRecord) -> bool:
    """Drop uvicorn's access records of successful GETs of a quiet path."""
    if record.name != "uvicorn.access" or not isinstance(record.args, tuple):
        return True
    # (client address, method, path, HTTP version, status code)
    if len(record.args) != 5:
        return True
    _, method, path, _, status = record.args
    return not (
        method == "GET"
        and isinstance(status, int)
        and status < 400
        and any(fnmatch.fnmatchcase(str(path).split("?")[0], p) for p in _quiet)
    )


def shutdown() -> None:
    """Flush pending records; call before the process exits."""
    if _provider is not None:
        _provider.shutdown()
