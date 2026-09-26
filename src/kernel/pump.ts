/**
 * RunPump — the idle waker (REFACTOR.md §2.5).
 *
 * An inject that arrives while the loop is idle has to become a run, and
 * deciding that is not the loop's job: the runner is a turn loop, not a
 * scheduler. The pump watches the two facts that matter — something entered
 * the inbox, or a run ended — and starts a run when there is work and nothing
 * is running.
 *
 * Two cases it exists for:
 * - idle: an inject arrives between runs, and nobody is holding the loop.
 * - racing run end: an inject lands while the last turn is finishing; the run
 *   that is ending does not see it, so the pump starts the next one.
 *
 * A host that wants a different policy (one session per keystroke, say, or a
 * manual-only mode) simply does not start the pump.
 */

import { kernelOn } from "../types/events";
import type { Kernel } from "./kernel";
import type { Runner } from "./runner";

export interface RunPumpOptions {
	/**
	 * Called when a pumped run ends. Defaults to nothing — a run's own result is
	 * on the bus (`turn:run-end`), where a dashboard reads it.
	 */
	onRunEnd?: (error: unknown) => void;
}

export class RunPump {
	private readonly kernel: Kernel;
	private readonly runner: Runner;
	private readonly onRunEnd: (error: unknown) => void;
	private readonly offs: (() => boolean)[] = [];
	private started = false;

	constructor(kernel: Kernel, runner: Runner, options: RunPumpOptions = {}) {
		this.kernel = kernel;
		this.runner = runner;
		this.onRunEnd = options.onRunEnd ?? (() => undefined);
		this.offs.push(
			kernelOn(kernel.ctx)("inject:received", () => {
				this.pump();
			}),
			kernelOn(kernel.ctx)("turn:run-end", () => {
				// A message may have arrived while the run was finishing.
				this.pump();
			}),
		);
	}

	start(): void {
		this.started = true;
		this.pump();
	}

	stop(): void {
		this.started = false;
		for (const off of this.offs.splice(0)) off();
	}

	/** Whether the pump is running the loop right now. */
	get running(): boolean {
		return this.runner.running;
	}

	/** Start a run if there is work and nothing is running. */
	pump(): void {
		if (!this.started) return;
		if (this.runner.running) return;
		if (this.kernel.inboxDepth === 0) return;
		void this.runner.run().catch((error: unknown) => {
			// A pumped run has no caller to throw to; the failure is reported and
			// the next inject can try again.
			this.onRunEnd(error);
		});
	}
}
