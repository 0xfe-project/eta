// Package telemetry sets up logging, error tracking and tracing for AXP's Go
// services, with the Sentry SDK.
//
// Services log through log/slog. Every record is a readable line on stderr
// and, when SENTRY_DSN is set, a Sentry log; errors are Sentry events as
// well, grouped into issues by their message. Without SENTRY_DSN nothing is
// sent. SENTRY_ENVIRONMENT names the environment and SENTRY_RELEASE (else
// AXP_VERSION, the deployed git commit) the release. HTTP servers add
// Middleware for a transaction per request and panics as events.
package telemetry

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/getsentry/sentry-go"
	sentryslog "github.com/getsentry/sentry-go/slog"
)

// Setup configures logging for service's command (tagged on every event),
// installs the returned logger as the slog default, and returns a shutdown
// function that flushes pending events.
func Setup(_ context.Context, service, command string) (*slog.Logger, func(context.Context) error, error) {
	var handler slog.Handler = newConsoleHandler(os.Stderr)
	if os.Getenv("SENTRY_DSN") != "" {
		release := os.Getenv("SENTRY_RELEASE")
		if release == "" {
			release = os.Getenv("AXP_VERSION")
		}
		err := sentry.Init(sentry.ClientOptions{
			Release:       release,
			Tags:          map[string]string{"service": service, "command": command},
			EnableTracing: true,
			// Health checks are not worth a transaction each.
			TracesSampler: func(ctx sentry.SamplingContext) float64 {
				if strings.HasSuffix(ctx.Span.Name, "/health") {
					return 0
				}
				return 1
			},
		})
		if err != nil {
			return nil, nil, err
		}
		handler = slog.NewMultiHandler(handler,
			sentryslog.Option{LogLevel: []slog.Level{slog.LevelInfo, slog.LevelWarn, slog.LevelError}}.NewSentryHandler(context.Background()),
			issueHandler{})
	}
	logger := slog.New(levelHandler{handler})
	slog.SetDefault(logger)
	return logger, flush, nil
}

func flush(ctx context.Context) error {
	if sentry.CurrentHub().Client() == nil {
		return nil // no SENTRY_DSN
	}
	if !sentry.FlushWithContext(ctx) {
		return errors.New("sentry: events still pending")
	}
	return nil
}

// levelHandler drops debug records.
type levelHandler struct{ slog.Handler }

func (h levelHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return level >= slog.LevelInfo && h.Handler.Enabled(ctx, level)
}

func (h levelHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return levelHandler{h.Handler.WithAttrs(attrs)}
}

func (h levelHandler) WithGroup(name string) slog.Handler {
	return levelHandler{h.Handler.WithGroup(name)}
}

// Shutdown runs a shutdown function from Setup, ignoring a cancelled context.
func Shutdown(ctx context.Context, shutdown func(context.Context) error) error {
	if err := shutdown(ctx); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	return nil
}

// Recover reports a panic in the calling goroutine as a fatal event, waits
// for it to be sent, and panics again. Deferred at the top of main.
func Recover() {
	if r := recover(); r != nil {
		sentry.CurrentHub().Recover(r)
		sentry.Flush(5 * time.Second)
		panic(r)
	}
}
