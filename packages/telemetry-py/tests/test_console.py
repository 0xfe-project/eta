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
    monkeypatch.setattr(axp_telemetry, "_handler", None)
    axp_telemetry.setup("t")
    logging.getLogger("setup_test").warning(
        "request done", extra={"request": object(), "status_code": 404}
    )
    axp_telemetry.shutdown()

    err = capsys.readouterr().err
    assert re.search(r"WARN  request done status_code=404\n$", err)
    assert "recursive" not in err


def test_service_name_from_environment(monkeypatch):
    import axp_telemetry

    monkeypatch.setattr(axp_telemetry, "_provider", None)
    monkeypatch.setattr(axp_telemetry, "_handler", None)
    monkeypatch.setenv("OTEL_SERVICE_NAME", "control-plane-api")
    axp_telemetry.handler("control-plane")
    resource = axp_telemetry._provider.resource
    assert resource.attributes["service.name"] == "control-plane-api"


def test_uncaught_thread_exceptions_are_logged(monkeypatch, capsys):
    import threading

    import axp_telemetry

    monkeypatch.setattr(axp_telemetry, "_provider", None)
    monkeypatch.setattr(axp_telemetry, "_handler", None)
    monkeypatch.setattr(threading, "excepthook", threading.excepthook)
    axp_telemetry.setup("t")

    def boom():
        raise RuntimeError("worker failed")

    thread = threading.Thread(target=boom, name="worker")
    thread.start()
    thread.join()
    axp_telemetry.shutdown()

    err = capsys.readouterr().err
    assert "ERROR uncaught exception in thread worker" in err
    assert "exception.type=RuntimeError" in err
    assert "\nTraceback (most recent call last):\n" in err


def test_successful_reads_are_not_logged(monkeypatch, capsys):
    import axp_telemetry

    monkeypatch.setattr(axp_telemetry, "_provider", None)
    monkeypatch.setattr(axp_telemetry, "_handler", None)
    axp_telemetry.setup("t", quiet=("/up", "/agents/*/memories"))
    access = logging.getLogger("uvicorn.access")
    line = '%s - "%s %s HTTP/%s" %d'
    access.info(line, "10.0.0.1:1", "GET", "/up", "1.1", 204)
    access.info(line, "10.0.0.1:1", "GET", "/agents/a1/memories?q=x", "1.1", 200)
    access.info(line, "10.0.0.1:1", "GET", "/agents/a1", "1.1", 200)
    access.info(line, "10.0.0.1:1", "GET", "/missing", "1.1", 404)
    access.info(line, "10.0.0.1:1", "POST", "/memory/capture", "1.1", 202)
    axp_telemetry.shutdown()

    err = capsys.readouterr().err
    assert "GET /up" not in err
    assert "GET /agents/a1/memories" not in err
    assert 'GET /agents/a1 HTTP/1.1" 200' in err
    assert 'GET /missing HTTP/1.1" 404' in err
    assert "POST /memory/capture" in err


def test_service_version_from_the_deployment(monkeypatch):
    import axp_telemetry

    monkeypatch.setattr(axp_telemetry, "_provider", None)
    monkeypatch.setattr(axp_telemetry, "_handler", None)
    monkeypatch.setenv("AXP_VERSION", "abc123")
    axp_telemetry.handler("t")
    assert axp_telemetry._provider.resource.attributes["service.version"] == "abc123"
