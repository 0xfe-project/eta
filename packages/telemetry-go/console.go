package telemetry

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/log"
	sdklog "go.opentelemetry.io/otel/sdk/log"
)

// consoleExporter writes each record as one readable line:
//
//	15:04:05.000 INFO  message key=value trace=0af76519
//
// Times are UTC, like the containers (Django switches its processes to UTC).
// The same format is used by the Python and JavaScript services.
type consoleExporter struct {
	mu  sync.Mutex
	out io.Writer
}

func newConsoleExporter(out io.Writer) *consoleExporter {
	return &consoleExporter{out: out}
}

func (e *consoleExporter) Export(_ context.Context, records []sdklog.Record) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, r := range records {
		if _, err := io.WriteString(e.out, formatLine(r)); err != nil {
			return err
		}
	}
	return nil
}

func (e *consoleExporter) Shutdown(context.Context) error   { return nil }
func (e *consoleExporter) ForceFlush(context.Context) error { return nil }

func formatLine(r sdklog.Record) string {
	var b strings.Builder
	ts := r.Timestamp()
	if ts.IsZero() {
		ts = r.ObservedTimestamp()
	}
	b.WriteString(ts.UTC().Format("15:04:05.000"))
	fmt.Fprintf(&b, " %-5s %s", levelName(r.Severity()), r.Body().AsString())
	r.WalkAttributes(func(kv attribute.KeyValue) bool {
		b.WriteString(" ")
		b.WriteString(string(kv.Key))
		b.WriteString("=")
		b.WriteString(formatValue(kv.Value))
		return true
	})
	if id := r.TraceID(); id.IsValid() {
		b.WriteString(" trace=")
		b.WriteString(id.String()[:8])
	}
	b.WriteString("\n")
	return b.String()
}

func levelName(s log.Severity) string {
	switch {
	case s >= log.SeverityFatal:
		return "FATAL"
	case s >= log.SeverityError:
		return "ERROR"
	case s >= log.SeverityWarn:
		return "WARN"
	case s >= log.SeverityInfo:
		return "INFO"
	default:
		return "DEBUG"
	}
}

// formatValue quotes strings that would break the key=value layout.
func formatValue(v attribute.Value) string {
	if v.Type() != attribute.STRING {
		return v.Emit()
	}
	s := v.AsString()
	if s == "" || strings.ContainsAny(s, " \t\n\"=") {
		return strconv.Quote(s)
	}
	return s
}
