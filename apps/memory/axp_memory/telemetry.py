"""Logging, error tracking and tracing for the service, with the Sentry SDK.

The service logs through the standard ``logging`` module. Every record is a
readable line on stderr, in the format of AXP's Go and JS services:

    15:04:05.000 INFO  message key=value

(times in UTC) and, when SENTRY_DSN is set, a Sentry log; errors and
uncaught exceptions are Sentry events, requests transactions. Without
SENTRY_DSN nothing is sent.
"""

import fnmatch
import json
import logging
import os
import sys
from datetime import UTC, datetime

import sentry_sdk

__all__ = ["setup", "shutdown"]

# GET paths whose successful requests are neither logged nor traced.
_quiet: tuple[str, ...] = ()


def setup(service: str, quiet: tuple[str, ...] = ()) -> None:
    """Route the root logger to stderr and Sentry for ``service``.

    Successful GETs of a ``quiet`` path (an fnmatch pattern: health checks,
    polling) are left out of uvicorn's access log and of the traces.
    """
    global _quiet
    _quiet = quiet
    sentry_sdk.init(
        release=os.environ.get("SENTRY_RELEASE") or os.environ.get("AXP_VERSION"),
        enable_logs=True,
        traces_sampler=_sample,
    )
    sentry_sdk.set_tag("service", service)
    console = logging.StreamHandler(sys.stderr)
    console.setFormatter(_Line())
    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(console)
    root.setLevel(logging.INFO)
    # On the logger, so the record reaches neither stderr nor Sentry.
    logging.getLogger("uvicorn.access").addFilter(_skip_successful_reads)
    # One record per outgoing request (the model API's calls) says nothing
    # the caller does not log itself.
    logging.getLogger("httpx").setLevel(logging.WARNING)


def _sample(context: dict) -> float:
    path = (context.get("asgi_scope") or {}).get("path", "")
    return 0.0 if any(fnmatch.fnmatchcase(path, p) for p in _quiet) else 1.0


def shutdown() -> None:
    """Flush pending events; call before the process exits."""
    sentry_sdk.flush(timeout=5)


# Attributes of every LogRecord; the rest came from ``extra``.
_STANDARD = set(vars(logging.makeLogRecord({}))) | {"message", "asctime"}


class _Line(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        when = datetime.fromtimestamp(record.created, UTC).strftime("%H:%M:%S.%f")
        level = "WARN" if record.levelname == "WARNING" else record.levelname
        level = "FATAL" if level == "CRITICAL" else level
        parts = [f"{when[:-3]} {level:<5} {record.getMessage()}"]
        for key, value in vars(record).items():
            if key not in _STANDARD and isinstance(value, (str, bool, int, float)):
                parts.append(f"{key}={_value(value)}")
        line = " ".join(parts)
        # A traceback reads better as itself, below the line.
        if record.exc_info:
            line += "\n" + self.formatException(record.exc_info)
        return line


def _value(value) -> str:
    if not isinstance(value, str):
        return str(value)
    if not value or any(c in value for c in ' \t\n"='):
        return json.dumps(value, ensure_ascii=False)
    return value


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
