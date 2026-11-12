/**
 * Notes every call the interface makes on a wire and passes it on unchanged: how a test sees that
 * something was not sent at all, which the host's state alone cannot always show, and what the
 * host answered.
 */
import type { WireClient } from "../../src/connection/types";

export type CallOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: unknown };

export interface RecordedCall {
  op: string;
  args: unknown;
  /** Settles when the host has answered; never rejects. */
  outcome: Promise<CallOutcome>;
}

export function recordCalls(wire: WireClient): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const original = wire.call.bind(wire);
  const recorded = <T>(
    target: string,
    action: string,
    args?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T> => {
    const answer = original<T>(target, action, args, options);
    calls.push({
      op: `${target}.${action}`,
      args,
      outcome: answer.then(
        (value): CallOutcome => ({ ok: true, value }),
        (error: unknown): CallOutcome => ({ ok: false, error }),
      ),
    });
    return answer;
  };
  (wire as { call: WireClient["call"] }).call = recorded;
  return calls;
}

/** The screen with every space, line break and box edge taken out: what to look for wrapped text in. */
export function squash(text: string): string {
  return text.replace(/[\s│─┌┐└┘]/g, "");
}
