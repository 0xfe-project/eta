/**
 * Sends browser logs to the web server (POST /telemetry/logs), which forwards
 * them to OpenTelemetry: uncaught errors and unhandled rejections.
 */
type Level = "debug" | "info" | "warn" | "error";
type Attributes = Record<string, string | number | boolean>;

const ENDPOINT = "/telemetry/logs";
const MAX_PER_MINUTE = 30;

let queue: { level: Level; message: string; attributes?: Attributes }[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let windowStart = 0;
let sentInWindow = 0;

function reportLog(level: Level, message: string, attributes?: Attributes) {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    sentInWindow = 0;
  }
  if (++sentInWindow > MAX_PER_MINUTE) return; // a loop of errors must not flood the server
  queue.push({
    level,
    message: message.slice(0, 4000),
    attributes: { "url.path": location.pathname, ...attributes },
  });
  timer ??= setTimeout(flush, 1000);
}

function flush() {
  timer = undefined;
  if (!queue.length) return;
  const body = JSON.stringify(queue.slice(0, 50));
  queue = [];
  // sendBeacon survives the page closing; fetch covers browsers that refuse it.
  const sent = navigator.sendBeacon?.(
    ENDPOINT,
    new Blob([body], { type: "application/json" }),
  );
  if (!sent) {
    void fetch(ENDPOINT, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
      keepalive: true,
    }).catch(() => {});
  }
}

export function installErrorReporting() {
  window.addEventListener("error", (event) => {
    reportLog("error", event.message || String(event.error), {
      "code.file.path": event.filename,
      "code.line.number": event.lineno,
      ...(event.error instanceof Error && event.error.stack
        ? { "exception.stacktrace": event.error.stack.slice(0, 2000) }
        : {}),
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    reportLog(
      "error",
      reason instanceof Error ? reason.message : String(reason),
      {
        "exception.type": "unhandledrejection",
        ...(reason instanceof Error && reason.stack
          ? { "exception.stacktrace": reason.stack.slice(0, 2000) }
          : {}),
      },
    );
  });
  window.addEventListener("pagehide", flush);
}
