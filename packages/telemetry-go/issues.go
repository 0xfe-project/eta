package telemetry

import (
	"context"
	"log/slog"
	"strings"

	"github.com/getsentry/sentry-go"
)

// issueHandler makes each error record a Sentry event, grouped into an issue
// by its message (the error, which often names a resource, varies). The
// record's "error" attribute is the exception; the others its
// attributes context.
type issueHandler struct {
	err    error // from WithAttrs
	extra  []flatAttr
	prefix string
}

func (h issueHandler) Enabled(_ context.Context, level slog.Level) bool {
	return level >= slog.LevelError
}

func (h issueHandler) Handle(ctx context.Context, r slog.Record) error {
	hub := sentry.GetHubFromContext(ctx)
	if hub == nil {
		hub = sentry.CurrentHub()
	}
	event := sentry.NewEvent()
	event.Level = sentry.LevelError
	event.Message = r.Message
	event.Fingerprint = []string{r.Message}
	err := h.err
	attrs := sentry.Context{}
	for _, a := range h.extra {
		attrs[a.key] = a.value
	}
	r.Attrs(func(a slog.Attr) bool {
		if e, ok := a.Value.Any().(error); ok && a.Key == "error" && h.prefix == "" {
			err = e
			return true
		}
		for _, a := range flatten(h.prefix, a) {
			attrs[a.key] = a.value
		}
		return true
	})
	event.Contexts["attributes"] = attrs
	if err != nil {
		// The message is the title; the stack is where it was logged.
		event.Exception = []sentry.Exception{{
			Type: r.Message, Value: err.Error(), Stacktrace: callerStack(),
		}}
	}
	hub.CaptureEvent(event)
	return nil
}

func (h issueHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	h.extra = h.extra[:len(h.extra):len(h.extra)] // never share the backing array
	for _, a := range attrs {
		if e, ok := a.Value.Any().(error); ok && a.Key == "error" && h.prefix == "" {
			h.err = e
			continue
		}
		h.extra = append(h.extra, flatten(h.prefix, a)...)
	}
	return h
}

func (h issueHandler) WithGroup(name string) slog.Handler {
	h.prefix += name + "."
	return h
}

type flatAttr struct{ key, value string }

func flatten(prefix string, a slog.Attr) []flatAttr {
	a.Value = a.Value.Resolve()
	if a.Value.Kind() != slog.KindGroup {
		return []flatAttr{{prefix + a.Key, a.Value.String()}}
	}
	if a.Key != "" {
		prefix += a.Key + "."
	}
	var out []flatAttr
	for _, g := range a.Value.Group() {
		out = append(out, flatten(prefix, g)...)
	}
	return out
}

// callerStack is the stack up to the code that logged, without slog's and
// these handlers' frames (the issue's culprit is its innermost frame).
func callerStack() *sentry.Stacktrace {
	stack := sentry.NewStacktrace()
	if stack == nil {
		return nil
	}
	frames := stack.Frames // outermost first
	for len(frames) > 1 && logging(frames[len(frames)-1]) {
		frames = frames[:len(frames)-1]
	}
	stack.Frames = frames
	return stack
}

func logging(f sentry.Frame) bool {
	if f.Module == "log/slog" {
		return true
	}
	return f.Module == "github.com/akarachen/axp/packages/telemetry-go" &&
		(strings.HasPrefix(f.Function, "issueHandler.") || strings.HasPrefix(f.Function, "levelHandler.") || f.Function == "callerStack")
}
