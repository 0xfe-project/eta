/**
 * Preloaded into a real host: the instant it prints its startup summary, it is sent a SIGTERM,
 * before it runs another line. That is a stop from whoever started it, as early as one can come.
 */
import process from "node:process";

const log = console.log.bind(console);
console.log = (...args: unknown[]) => {
  log(...args);
  if (typeof args[0] !== "string") return;
  try {
    const parsed = JSON.parse(args[0]) as { port?: unknown };
    if (typeof parsed.port === "number") process.kill(process.pid, "SIGTERM");
  } catch {
    // Not the summary.
  }
};
