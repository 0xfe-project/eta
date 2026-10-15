package telemetry

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"sync"
)

// consoleHandler writes each record as one readable line:
//
//	15:04:05.000 INFO  message key=value
//
// Times are UTC, like the containers.
// The same format is used by the Python and JavaScript services.
type consoleHandler struct {
	mu     *sync.Mutex
	out    io.Writer
	attrs  string // pre-rendered " key=value…"
	prefix string // the open groups, "group."
}

func newConsoleHandler(out io.Writer) *consoleHandler {
	return &consoleHandler{mu: &sync.Mutex{}, out: out}
}

func (h *consoleHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h *consoleHandler) Handle(_ context.Context, r slog.Record) error {
	var b strings.Builder
	b.WriteString(r.Time.UTC().Format("15:04:05.000"))
	fmt.Fprintf(&b, " %-5s %s", levelName(r.Level), r.Message)
	b.WriteString(h.attrs)
	r.Attrs(func(a slog.Attr) bool {
		writeAttr(&b, h.prefix, a)
		return true
	})
	b.WriteString("\n")
	h.mu.Lock()
	defer h.mu.Unlock()
	_, err := io.WriteString(h.out, b.String())
	return err
}

func (h *consoleHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	var b strings.Builder
	for _, a := range attrs {
		writeAttr(&b, h.prefix, a)
	}
	next := *h
	next.attrs += b.String()
	return &next
}

func (h *consoleHandler) WithGroup(name string) slog.Handler {
	next := *h
	next.prefix += name + "."
	return &next
}

func writeAttr(b *strings.Builder, prefix string, a slog.Attr) {
	a.Value = a.Value.Resolve()
	if a.Value.Kind() == slog.KindGroup {
		if a.Key != "" {
			prefix += a.Key + "."
		}
		for _, g := range a.Value.Group() {
			writeAttr(b, prefix, g)
		}
		return
	}
	if a.Equal(slog.Attr{}) {
		return
	}
	b.WriteString(" ")
	b.WriteString(prefix + a.Key)
	b.WriteString("=")
	b.WriteString(formatValue(a.Value))
}

func levelName(l slog.Level) string {
	switch {
	case l >= slog.LevelError:
		return "ERROR"
	case l >= slog.LevelWarn:
		return "WARN"
	case l >= slog.LevelInfo:
		return "INFO"
	default:
		return "DEBUG"
	}
}

// formatValue quotes strings that would break the key=value layout.
func formatValue(v slog.Value) string {
	s := v.String()
	if v.Kind() == slog.KindString && (s == "" || strings.ContainsAny(s, " \t\n\"=")) ||
		v.Kind() == slog.KindAny && strings.ContainsAny(s, " \t\n\"=") {
		return strconv.Quote(s)
	}
	return s
}
