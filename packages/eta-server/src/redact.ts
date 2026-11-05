/**
 * Keeping known secrets out of a session on eta's own loop.
 *
 * A tool's result is what reaches the model and the journal, and a script can print whatever it
 * found in a file or a process's environment. This middleware takes every value it was given out of
 * results and progress updates, on their way in. It sees exact text only: a value encoded by the
 * script comes through, so it is a guard against accidents and not a boundary.
 */
import type { Redaction } from "@eta/client-contracts";
import type { ToolMiddleware } from "@eta/core";

/** Shorter than this and a "secret" would be cut out of ordinary words. */
const MIN_LENGTH = 4;

function scrubText(text: string, redactions: readonly Redaction[]): string {
  let scrubbed = text;
  for (const { value, label } of redactions)
    if (scrubbed.includes(value)) scrubbed = scrubbed.replaceAll(value, label);
  return scrubbed;
}

function scrub(value: unknown, redactions: readonly Redaction[]): unknown {
  if (typeof value === "string") return scrubText(value, redactions);
  if (Array.isArray(value)) return value.map((item) => scrub(item, redactions));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        scrub(item, redactions),
      ]),
    );
  return value;
}

/** `read` is asked at each call, so a value saved while a session is open counts from then on. */
export function redactionMiddleware(
  read: () => readonly Redaction[],
): ToolMiddleware {
  /** Longest first: one secret can be part of another. */
  const current = (): Redaction[] =>
    read()
      .filter(({ value }) => value.length >= MIN_LENGTH)
      .sort((a, b) => b.value.length - a.value.length);
  return {
    name: "redact",
    before: (_name, args, call) => {
      const { update } = call;
      if (update !== undefined)
        // A running tool's progress goes to clients as it comes, past `after`.
        call.update = (partial, options) =>
          update(scrub(partial, current()), options);
      return { ok: true, args };
    },
    after: (_name, _args, result) => {
      const redactions = current();
      return redactions.length === 0 ? result : scrub(result, redactions);
    },
  };
}
