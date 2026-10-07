/**
 * Logging for the web server (Bun), via LogTape. Lines on stderr match the Go
 * and Python services (on unless AXP_LOG_CONSOLE=0); records also go to OTLP
 * when OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_LOGS_ENDPOINT is set.
 * Server-only; the browser does not report logs yet.
 */
import type { LogLevel, Sink } from "@logtape/logtape";
import process from "node:process";
import {
  configure,
  dispose,
  getConsoleSink,
  getLogger,
  getTextFormatter,
} from "@logtape/logtape";
import { getOpenTelemetrySink } from "@logtape/otel";

export const log = getLogger("web");

const levels: Record<string, LogLevel> = {
  debug: "debug",
  info: "info",
  warn: "warning",
  error: "error",
};

export async function setupTelemetry(service: string): Promise<void> {
  const sinks: Record<string, Sink> = {};
  if (process.env.AXP_LOG_CONSOLE !== "0") {
    sinks.console = getConsoleSink({
      formatter: getTextFormatter({
        // 15:04:05.000 INFO  message (UTC, like the Go and Python services)
        timestamp: (ts) => new Date(ts).toISOString().slice(11, 23),
        value: "bare",
        level: (level) => (level === "warning" ? "WARN" : level.toUpperCase()),
        format: ({ timestamp, level, message }) =>
          `${timestamp} ${level.padEnd(5)} ${message}`,
      }),
    });
  }
  if (
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
  ) {
    sinks.otel = getOpenTelemetrySink({
      serviceName: process.env.OTEL_SERVICE_NAME ?? service,
    });
  }
  await configure({
    sinks,
    loggers: [
      {
        category: "web",
        sinks: Object.keys(sinks),
        lowestLevel: levels[process.env.AXP_LOG_LEVEL ?? ""] ?? "info",
      },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "warning" },
    ],
  });
}

/** Flush pending records; call before the process exits. */
export const shutdownTelemetry = dispose;
