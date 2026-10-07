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
		{"API server started successfully on: 127.0.0.1:3004", "API server started successfully on: 127.0.0.1:3004", slog.LevelInfo, 0},
	}
	for _, c := range cases {
		level, message, attrs := parseLine(c.line)
		if level != c.level || message != c.message || len(attrs) != c.attrs {
			t.Errorf("parseLine(%q) = %v %q %v", c.line, level, message, attrs)
		}
	}
}
