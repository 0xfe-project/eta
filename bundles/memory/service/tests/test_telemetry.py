import logging
import re

from axp_memory import telemetry


def test_console_line(monkeypatch, capsys):
    monkeypatch.delenv("SENTRY_DSN", raising=False)
    telemetry.setup("t")
    logger = logging.getLogger("console_test")
    logger.debug("hidden")
    logger.warning(
        "runtime ready",
        extra={"agent": "a1", "note": "two words", "n": 3, "request": object()},
    )
    telemetry.shutdown()

    assert re.fullmatch(
        r'\d\d:\d\d:\d\d\.\d{3} WARN  runtime ready agent=a1 note="two words" n=3\n',
        capsys.readouterr().err,
    )


def test_successful_reads_are_not_logged(monkeypatch, capsys):
    monkeypatch.delenv("SENTRY_DSN", raising=False)
    telemetry.setup("t", quiet=("/up", "/agents/*/memories"))
    access = logging.getLogger("uvicorn.access")
    line = '%s - "%s %s HTTP/%s" %d'
    access.info(line, "10.0.0.1:1", "GET", "/up", "1.1", 204)
    access.info(line, "10.0.0.1:1", "GET", "/agents/a1/memories?q=x", "1.1", 200)
    access.info(line, "10.0.0.1:1", "GET", "/agents/a1", "1.1", 200)
    access.info(line, "10.0.0.1:1", "GET", "/missing", "1.1", 404)
    access.info(line, "10.0.0.1:1", "POST", "/memory/capture", "1.1", 202)
    telemetry.shutdown()

    err = capsys.readouterr().err
    assert "GET /up" not in err
    assert "GET /agents/a1/memories" not in err
    assert "GET /agents/a1 " in err
    assert "GET /missing" in err
    assert "POST /memory/capture" in err
    assert telemetry._sample({"asgi_scope": {"path": "/up"}}) == 0.0
    assert telemetry._sample({"asgi_scope": {"path": "/memory/mcp"}}) == 1.0
