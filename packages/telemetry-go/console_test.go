package telemetry

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	sdklog "go.opentelemetry.io/otel/sdk/log"
)

func TestConsoleLine(t *testing.T) {
	var out bytes.Buffer
	provider := sdklog.NewLoggerProvider(
		sdklog.WithProcessor(sdklog.NewSimpleProcessor(newConsoleExporter(&out))),
	)
	logger := slog.New(levelHandler{otelslog.NewHandler("t", otelslog.WithLoggerProvider(provider))})

	logger.Debug("hidden")
	logger.Warn("gateway listening", "addr", ":8080", "note", "two words", "n", 3)
	_ = provider.Shutdown(context.Background())

	line := out.String()
	if strings.Contains(line, "hidden") {
		t.Fatalf("debug record below the level was written: %q", line)
	}
	want := ` WARN  gateway listening addr=:8080 note="two words" n=3` + "\n"
	if !strings.HasSuffix(line, want) || len(line) != len("15:04:05.000")+len(want) {
		t.Fatalf("line = %q, want time followed by %q", line, want)
	}
}
