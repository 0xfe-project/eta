"""OpenTelemetry setup shared by AXP's Python services.

Services log through the standard ``logging`` module. Every record goes
through the OpenTelemetry log pipeline to two exporters: a readable line on
stderr (on unless AXP_LOG_CONSOLE=0) and OTLP, when OTEL_EXPORTER_OTLP_ENDPOINT
or OTEL_EXPORTER_OTLP_LOGS_ENDPOINT is set. Everything else uses the standard
OTEL_* variables. Records logged inside a span carry its trace once tracing is
added.
"""

import logging
import os

from opentelemetry._logs import set_logger_provider
from opentelemetry.instrumentation.logging.handler import LoggingHandler
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import (
    BatchLogRecordProcessor,
    SimpleLogRecordProcessor,
)
from opentelemetry.sdk.resources import SERVICE_NAME, Resource

from .console import ConsoleExporter

__all__ = ["setup", "shutdown"]

_provider: LoggerProvider | None = None


def setup(service: str) -> None:
    """Route the root logger through OpenTelemetry for ``service``.

    OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES override the defaults.
    Calling it again is a no-op.
    """
    global _provider
    if _provider is not None:
        return
    provider = LoggerProvider(resource=Resource.create({SERVICE_NAME: service}))
    if os.environ.get("AXP_LOG_CONSOLE") != "0":
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

    handler = LoggingHandler(logger_provider=provider)
    handler.addFilter(_keep_valid_attributes)
    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(os.environ.get("AXP_LOG_LEVEL", "INFO").upper())
    _provider = provider


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
