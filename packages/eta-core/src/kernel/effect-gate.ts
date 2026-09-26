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

/** Procedure-facing synchronous admission capability for one drive pass. */
export interface Gate {
	readonly signal: AbortSignal;
	admit<T>(invoke: () => T): T;
}

/** Owner-facing lifecycle controls for one drive pass. */
export interface GateControl {
	beginAbort(cancellation: Promise<void>): void;
	signalAbort(): void;
	close(error: Error): void;
}

type GateState =
	| { status: "open" }
	| { status: "aborting"; cancellation: Promise<void> }
	| { status: "closed"; error: Error };

/** Create separate procedure-facing and owner-facing views of one effect gate. */
export function createGate(): { gate: Gate; control: GateControl } {
	let state: GateState = { status: "open" };
	const controller = new AbortController();

	const check = (): void => {
		if (state.status === "aborting") throw new AbortRequested(state.cancellation);
		if (state.status === "closed") throw state.error;
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
			close(error) {
				if (state.status === "closed") return;
				state = { status: "closed", error };
				if (!controller.signal.aborted) controller.abort(error);
			},
		},
	};
}
