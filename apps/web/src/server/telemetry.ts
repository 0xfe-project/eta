/**
 * Logging for the web server (Bun), via LogTape. Lines on stderr match the Go
 * and Python services; records also go to OTLP, to OTEL_EXPORTER_OTLP_ENDPOINT
 * or OTEL_EXPORTER_OTLP_LOGS_ENDPOINT (unset only in tests).
 * Used by the Bun static server, not the browser bundle.
 */
import type { Sink } from "@logtape/logtape";
import type { LoggerProvider as ApiLoggerProvider } from "@opentelemetry/api-logs";
import process from "node:process";
import {
  configure,
  dispose,
  getConfig,
  getConsoleSink,
  getLogger,
  getTextFormatter,
} from "@logtape/logtape";
import { getOpenTelemetrySink } from "@logtape/otel";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import {
  detectResources,
  envDetector,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";

export const log = getLogger("web");

export async function setupTelemetry(service: string): Promise<void> {
  if (getConfig()) return; // already set up in this process
  const sinks: Record<string, Sink> = {
    console: getConsoleSink({
      formatter: getTextFormatter({
        // 15:04:05.000 INFO  message (UTC, like the Go and Python services)
        timestamp: (ts) => new Date(ts).toISOString().slice(11, 23),
        value: "bare",
        level: (level) => (level === "warning" ? "WARN" : level.toUpperCase()),
        format: ({ timestamp, level, message }) =>
          `${timestamp} ${level.padEnd(5)} ${message}`,
      }),
    }),
  };
  if (
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
  ) {
    sinks.otel = getOpenTelemetrySink({
      loggerProvider: otlpProvider(service),
    });
  }
  await configure({
    sinks,
    loggers: [
      {
        category: "web",
        sinks: Object.keys(sinks),
        lowestLevel: "info",
      },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "warning" },
    ],
  });
}

/**
 * Batches records to OTLP (the sink's own provider sends each record in its
 * own request) and names levels like the Go and Python services: LogTape's
 * "info" and "warning" become "INFO" and "WARN".
 */
function otlpProvider(service: string): ApiLoggerProvider {
  const provider = new LoggerProvider({
    // OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES override the defaults;
    // deploy/k3s sets the deployed version (its git commit) in every container.
    resource: resourceFromAttributes({
      "service.name": service,
      ...(process.env.AXP_VERSION
        ? { "service.version": process.env.AXP_VERSION }
        : {}),
    }).merge(detectResources({ detectors: [envDetector] })),
    processors: [new BatchLogRecordProcessor(new OTLPLogExporter())],
  });
  return {
    getLogger: (...args) => {
      const logger = provider.getLogger(...args);
      return {
        emit: (record) =>
          logger.emit({
            ...record,
            severityText:
              record.severityText === "warning"
                ? "WARN"
                : record.severityText?.toUpperCase(),
          }),
      };
    },
    // LogTape's dispose() flushes the sink through this.
    shutdown: () => provider.shutdown(),
  } as ApiLoggerProvider;
}

/** Flush pending records; call before the process exits. */
export const shutdownTelemetry = dispose;
