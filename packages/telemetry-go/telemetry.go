// Package telemetry sets up OpenTelemetry for AXP's Go services.
//
// Services log through log/slog. Every record goes through the OpenTelemetry
// log pipeline to two exporters: a readable line on stderr and OTLP, to
// OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_LOGS_ENDPOINT (unset only
// in tests). Everything else uses the standard OTEL_* variables. Logging with a context (slog.InfoContext) attaches the
// active trace once tracing is added.
package telemetry

import (
	"context"
	"errors"
	"log/slog"
	"os"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/log/global"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/resource"
)

// Setup configures logging for service, installs the returned logger as the
// slog default, and returns a shutdown function that flushes pending records.
func Setup(ctx context.Context, service string) (*slog.Logger, func(context.Context) error, error) {
	attrs := []attribute.KeyValue{attribute.String("service.name", service)}
	// deploy/k3s sets the deployed version (its git commit) in every container.
	if version := os.Getenv("AXP_VERSION"); version != "" {
		attrs = append(attrs, attribute.String("service.version", version))
	}
	res, err := resource.New(ctx,
		resource.WithAttributes(attrs...),
		resource.WithTelemetrySDK(),
		resource.WithFromEnv(), // OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES win
	)
	if err != nil {
		return nil, nil, err
	}
	opts := []sdklog.LoggerProviderOption{
		sdklog.WithResource(res),
		sdklog.WithProcessor(sdklog.NewSimpleProcessor(newConsoleExporter(os.Stderr))),
	}
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" || os.Getenv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT") != "" {
		exporter, err := otlploghttp.New(ctx)
		if err != nil {
			return nil, nil, err
		}
		opts = append(opts, sdklog.WithProcessor(sdklog.NewBatchProcessor(exporter)))
	}
	provider := sdklog.NewLoggerProvider(opts...)
	global.SetLoggerProvider(provider)

	handler := otelslog.NewHandler(service, otelslog.WithLoggerProvider(provider))
	logger := slog.New(levelHandler{handler})
	slog.SetDefault(logger)
	return logger, provider.Shutdown, nil
}

// levelHandler drops debug records before they reach OpenTelemetry.
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
