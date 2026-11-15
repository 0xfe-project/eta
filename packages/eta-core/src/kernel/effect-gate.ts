/**
 * The effect gate (port of eta-agent's execution/effect-gate.ts).
 *
 * Cancellation cannot un-run an effect, so it does two things instead: it
 * stops admitting new ones, and it aborts the signal the running ones observe.
 * The caller then waits for them to drain — `AbortRequested` carries the
 * promise that says when that is done, so nobody has to guess whether a tool
 * that already started has finished.
 */

/** Expected internal control flow when cancellation wins effect admission. */
export class AbortRequested extends Error {
  readonly cancellation: Promise<void>;

  constructor(cancellation: Promise<void>) {
    super("Abort requested");
    this.name = "AbortRequested";
    this.cancellation = cancellation;
  }
}

/**
 * The cancellation a signal carries, when its own gate aborted it.
 *
 * This is how an effect's ending is attributed to the run rather than to the
 * effect: once the gate that owns `signal` has been cancelled, whatever the
 * effect it handed that signal to ends with — an `AbortError`, the signal's own
 * reason, or a plain `Error("aborted")` from a provider that spells it its own
 * way — is that cancellation, not a failure. The source is the signal, never
 * the error's name or message: a timeout aborts the signal
 * with some other reason and is not a cancellation, and a signal nobody aborted
 * says nothing, so a real failure stays a failure.
 */
export function cancellationOf(
  signal: AbortSignal | undefined,
): AbortRequested | undefined {
  if (signal?.aborted !== true) return undefined;
  return signal.reason instanceof AbortRequested ? signal.reason : undefined;
}

/** Procedure-facing synchronous admission capability for one drive pass. */
export interface Gate {
  readonly signal: AbortSignal;
  admit: <T>(invoke: () => T) => T;
}

/** Owner-facing lifecycle controls for one drive pass. */
export interface GateControl {
  beginAbort: (cancellation: Promise<void>) => void;
  signalAbort: () => void;
}

type GateState =
  | { status: "open" }
  | { status: "aborting"; cancellation: Promise<void> };

/** Create separate procedure-facing and owner-facing views of one effect gate. */
export function createGate(): { gate: Gate; control: GateControl } {
  let state: GateState = { status: "open" };
  const controller = new AbortController();

  const check = (): void => {
    if (state.status === "aborting")
      throw new AbortRequested(state.cancellation);
  };

  return {
    gate: {
      admit<T>(invoke: () => T): T {
        check();
        return invoke();
      },
      signal: controller.signal,
    },
    control: {
      beginAbort(cancellation) {
        if (state.status !== "open") return;
        state = { status: "aborting", cancellation };
      },
      signalAbort() {
        if (state.status !== "aborting" || controller.signal.aborted) return;
        controller.abort(new AbortRequested(state.cancellation));
      },
    },
  };
}
