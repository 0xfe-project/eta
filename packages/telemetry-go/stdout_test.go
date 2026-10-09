package telemetry

import (
	"log/slog"
	"testing"
)

func TestParseLine(t *testing.T) {
	cases := []struct {
		line, message string
		level         slog.Level
		attrs         int
	}{
		{"[2026-10-07 09:45:46] [--------] [info ] [server.go:12] API server started", "API server started", slog.LevelInfo, 1},
		{"[2026-10-07 09:45:46] [a1b2c3d4] [warn ] [auth.go:9] token expired", "token expired", slog.LevelWarn, 2},
		{`time="2026-10-07T09:45:46+02:00" level=error msg="failed to load: \"x\""`, `failed to load: "x"`, slog.LevelError, 0},
		{`[2026-10-07 09:45:46] [--------] [info ] [gin_logger.go:90] 200 |      0s |  127.0.0.1 | GET     "/"`, `200 |      0s |  127.0.0.1 | GET     "/"`, slog.LevelDebug, 1},
		{`[2026-10-07 09:45:46] [a1b2c3d4] [info ] [gin_logger.go:90] 200 |   1.2s | 172.21.0.8 | POST    "/v1/responses"`, `200 |   1.2s | 172.21.0.8 | POST    "/v1/responses"`, slog.LevelInfo, 2},
		{`[2026-10-07 09:45:46] [a1b2c3d4] [info ] [gin_logger.go:90] 404 |    1ms | 172.21.0.8 | GET     "/nowhere"`, `404 |    1ms | 172.21.0.8 | GET     "/nowhere"`, slog.LevelWarn, 2},
		{`[2026-10-07 09:45:46] [a1b2c3d4] [warn ] [gin_logger.go:90] 502 | 1.385s | upstream execution failed`, `502 | 1.385s | upstream execution failed`, slog.LevelError, 2},
		{`time="2026-10-07T09:45:46Z" level=info msg="200 |      0s |  127.0.0.1 | GET     \"/\""`, `200 |      0s |  127.0.0.1 | GET     "/"`, slog.LevelDebug, 0},
		{`200 |      0s |  127.0.0.1 | GET     "/api/llm/v1/logins/abc?x=1"`, `200 |      0s |  127.0.0.1 | GET     "/api/llm/v1/logins/abc?x=1"`, slog.LevelDebug, 0},
		{`200 |      0s |  127.0.0.1 | GET     "/api/llm/v1/usage"`, `200 |      0s |  127.0.0.1 | GET     "/api/llm/v1/usage"`, slog.LevelInfo, 0},
		{"API server started successfully on: 127.0.0.1:3004", "API server started successfully on: 127.0.0.1:3004", slog.LevelInfo, 0},
	}
	for _, c := range cases {
		level, message, attrs := parseLine(c.line, []string{"/", "/api/llm/v1/logins/*"})
		if level != c.level || message != c.message || len(attrs) != c.attrs {
			t.Errorf("parseLine(%q) = %v %q %v", c.line, level, message, attrs)
		}
	}
}
