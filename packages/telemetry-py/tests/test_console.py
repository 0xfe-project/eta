import io
import logging
import re

from axp_telemetry.console import ConsoleExporter
from opentelemetry.instrumentation.logging.handler import LoggingHandler
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import SimpleLogRecordProcessor


def test_console_line():
    out = io.StringIO()
    provider = LoggerProvider()
    provider.add_log_record_processor(SimpleLogRecordProcessor(ConsoleExporter(out)))
    logger = logging.getLogger("console_test")
    logger.propagate = False
    handler = LoggingHandler(logger_provider=provider)
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

    logger.debug("hidden")
    logger.warning("runtime ready", extra={"agent": "a1", "note": "two words", "n": 3})
    provider.shutdown()
    logger.removeHandler(handler)

    assert re.fullmatch(
        r'\d\d:\d\d:\d\d\.\d{3} WARN  runtime ready agent=a1 note="two words" n=3\n',
        out.getvalue(),
    )


def test_setup_drops_attributes_otel_cannot_hold(monkeypatch, capsys):
    import axp_telemetry

    monkeypatch.setattr(axp_telemetry, "_provider", None)
    axp_telemetry.setup("t")
    logging.getLogger("setup_test").warning(
        "request done", extra={"request": object(), "status_code": 404}
    )
    axp_telemetry.shutdown()

    err = capsys.readouterr().err
    assert re.search(r"WARN  request done status_code=404\n$", err)
    assert "recursive" not in err
