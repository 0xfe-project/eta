// Ported from pi-mcp-adapter/failure-backoff.ts (MIT, see ../NOTICE); the failure tracker is its own class instead of fields on the session state.
/**
 * After a server fails to connect, calls fail fast for a minute instead of each paying for another
 * doomed attempt. An explicit `connect` ignores the window.
 */

export const FAILURE_BACKOFF_MS = 60 * 1000;
// A stored failure can hold 8 KiB of stderr; the model sees the reason on every blocked call.
const AGENT_FAILURE_REASON_CHARS = 300;

interface Failure {
  at: number;
  message: string;
}

export class FailureTracker {
  private readonly failures = new Map<string, Failure>();

  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  record(key: string, message: string): void {
    this.failures.set(key, { at: this.now(), message });
  }

  clear(key: string): void {
    this.failures.delete(key);
  }

  /** Seconds since the failure, or undefined outside the backoff window. */
  ageSeconds(key: string): number | undefined {
    const failure = this.failures.get(key);
    if (!failure) return undefined;
    const age = this.now() - failure.at;
    if (age > FAILURE_BACKOFF_MS) return undefined;
    return Math.round(age / 1000);
  }

  message(key: string): string | undefined {
    return this.ageSeconds(key) === undefined
      ? undefined
      : this.failures.get(key)?.message;
  }

  /** "failed 12s ago: <reason>" for the model, or undefined outside the window. */
  describe(key: string): string | undefined {
    const age = this.ageSeconds(key);
    if (age === undefined) return undefined;
    const reason = squash(this.failures.get(key)?.message ?? "");
    return reason ? `failed ${age}s ago: ${reason}` : `failed ${age}s ago`;
  }
}

/** One line, control characters gone, cut at a word. */
function squash(text: string): string {
  const clean = text
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= AGENT_FAILURE_REASON_CHARS) return clean;
  const cut = clean.slice(0, AGENT_FAILURE_REASON_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
