"""Readable one-line log output, shared in format with the Go and JS services:

15:04:05.000 INFO  message key=value trace=0af76519

Times are UTC, like the containers (Django switches its processes to UTC).
"""

import json
import sys
import threading
from collections.abc import Sequence
from datetime import UTC, datetime

from opentelemetry._logs import SeverityNumber
from opentelemetry.sdk._logs.export import LogRecordExporter, LogRecordExportResult


class ConsoleExporter(LogRecordExporter):
    def __init__(self, out=None):
        # None: whatever sys.stderr is at write time (test runners swap it).
        self._out = out
        self._lock = threading.Lock()

    def export(self, batch: Sequence) -> LogRecordExportResult:
        lines = "".join(format_line(item.log_record) for item in batch)
        out = self._out or sys.stderr
        with self._lock:
            out.write(lines)
            out.flush()
        return LogRecordExportResult.SUCCESS

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return True

    def shutdown(self) -> None:
        pass


def format_line(record) -> str:
    timestamp = record.timestamp or record.observed_timestamp
    when = datetime.fromtimestamp(timestamp / 1e9, UTC).strftime("%H:%M:%S.%f")[:-3]
    parts = [f"{when} {_level(record.severity_number):<5} {record.body}"]
    attributes = dict(record.attributes or {})
    # A traceback reads better as itself, below the line.
    stacktrace = attributes.pop("exception.stacktrace", None)
    for key, value in attributes.items():
        parts.append(f"{key}={_value(value)}")
    if record.trace_id:
        parts.append(f"trace={record.trace_id:032x}"[:14])
    line = " ".join(parts) + "\n"
    return line + stacktrace.rstrip("\n") + "\n" if stacktrace else line


def _level(severity: SeverityNumber | None) -> str:
    number = severity.value if severity else 0
    for floor, name in ((21, "FATAL"), (17, "ERROR"), (13, "WARN"), (9, "INFO")):
        if number >= floor:
            return name
    return "DEBUG"


def _value(value) -> str:
    if not isinstance(value, str):
        return str(value)
    if not value or any(c in value for c in ' \t\n"='):
        return json.dumps(value, ensure_ascii=False)
    return value
