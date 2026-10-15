/**
 * Logging, error tracking and tracing for the web server (Bun), with the
 * Sentry SDK. Lines on stderr match the Go and Python services; with
 * SENTRY_DSN set, records are Sentry logs as well and errors Sentry events.
 * Without it nothing is sent. Used by the Bun static server, not the browser
 * bundle.
 */
import process from "node:process";
import * as Sentry from "@sentry/bun";

type Level = "info" | "warn" | "error";
type Attributes = Record<string, string | number | boolean>;

/** The deployed version (deploy/k3s sets AXP_VERSION, its git commit). */
const release = () => process.env.SENTRY_RELEASE || process.env.AXP_VERSION;

export function setupTelemetry(service: string): void {
  if (!process.env.SENTRY_DSN || Sentry.isInitialized()) return;
  Sentry.init({
    release: release(),
    tracesSampleRate: 1,
    // Health checks and the browser's polling for a new build are not worth
    // a transaction each.
    ignoreTransactions: ["GET /up", "GET /version"],
    initialScope: { tags: { service } },
  });
}

function write(level: Level, message: string, attributes?: Attributes) {
  // 15:04:05.000 INFO  message key=value (UTC, like the Go and Python services)
  const pairs = Object.entries(attributes ?? {}).map(([k, v]) => {
    const s = String(v);
    return ` ${k}=${s === "" || /[\s"=]/.test(s) ? JSON.stringify(s) : s}`;
  });
  process.stderr.write(
    `${new Date().toISOString().slice(11, 23)} ${level.toUpperCase().padEnd(5)} ${message}${pairs.join("")}\n`,
  );
  Sentry.logger[level](message, attributes);
}

export const log = {
  info: (message: string, attributes?: Attributes) =>
    write("info", message, attributes),
  warn: (message: string, attributes?: Attributes) =>
    write("warn", message, attributes),
  error: (message: string, attributes?: Attributes) =>
    write("error", message, attributes),
};

/** Flush pending events; call before the process exits. */
export async function shutdownTelemetry(): Promise<void> {
  await Sentry.close(2000);
}
