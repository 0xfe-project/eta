/**
 * One pacer per session, between the projector and the sockets.
 *
 * The projector re-derives the *whole* SessionView on every streamed token, and a
 * long session's view is megabytes (measured: 2.0MB at 675 messages, 46% of it
 * finished tool results). Emitting straight through put the entire transcript on
 * the wire 21 times a second — 42MB/s to a single browser tab, which then spent
 * most of its main thread re-parsing and re-reconciling a view in which one
 * character had moved.
 *
 * So the pacer publishes the *newest* view and drops every intermediate one, and
 * lets each frame buy its own silence in proportion to its size: the bigger the
 * session, the fewer frames it costs, and the cost stops scaling with length.
 * The session in front gets a tight floor so streaming still looks live; the ones
 * behind it settle for a few updates a second. A trailing timer means the last
 * state always lands, even when the events stop mid-sentence.
 *
 * Same shape as core's AdaptivePublisher (used for shell output), with the floor
 * made dynamic — which session is "in front" changes while the run is going.
 */

export interface ViewPacerOptions {
	/**
	 * Floor between two frames, read at publish time: which session the user is
	 * looking at changes while the session is running.
	 */
	minIntervalMs(): number;
	/** Wire budget; a frame of N bytes buys `N / this` milliseconds of quiet. */
	targetBytesPerSecond(): number;
	/**
	 * Encode the newest frame, or return `undefined` when it is identical to the
	 * one already published. `forced` is the publishNow path (a user did something,
	 * or switched to this session) where re-sending the same bytes beats waiting.
	 */
	encode(forced: boolean): string | undefined;
	deliver(payload: string): void;
	now?: () => number;
	schedule?: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
	unschedule?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class ViewPacer {
	private readonly options: ViewPacerOptions;
	private readonly now: () => number;
	private dirty = false;
	private nextAt = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	constructor(options: ViewPacerOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	/** The view changed. Publish now if we are past the floor, otherwise coalesce. */
	markDirty(): void {
		if (this.disposed) return;
		this.dirty = true;
		const wait = this.nextAt - this.now();
		if (wait <= 0) {
			this.publish(false);
			return;
		}
		this.arm(wait);
	}

	/**
	 * Deliver the newest view without waiting for the budget — run end, a switch
	 * onto this session, an op the user just clicked. Still one frame, not one per
	 * event that happened to be in flight.
	 */
	publishNow(): void {
		if (this.disposed) return;
		this.dirty = true;
		this.publish(true);
	}

	/**
	 * Forgive the accumulated budget: the next frame goes out as soon as it is
	 * dirty. Used when a run ends — the last frame of a run is the one that says
	 * "not running any more", and it must not sit behind a wait bought by the
	 * frames that came before it.
	 */
	relax(): void {
		this.nextAt = 0;
	}

	dispose(): void {
		if (this.timer !== undefined) this.clearTimer();
		this.disposed = true;
	}

	private publish(forced: boolean): void {
		if (this.timer !== undefined) this.clearTimer();
		if (!this.dirty) return;
		const wait = this.nextAt - this.now();
		if (!forced && wait > 0) {
			this.arm(wait);
			return;
		}
		let payload: string | undefined;
		try {
			payload = this.options.encode(forced);
		} catch {
			// A view that will not serialize stays dirty and is retried on the next
			// change. Letting the throw out of here would unwind the harness event
			// dispatch that triggered it, and a frame would take the run down with it.
			this.arm(this.options.minIntervalMs());
			return;
		}
		this.dirty = false;
		if (payload === undefined) return;
		const delivered = this.now();
		this.nextAt =
			delivered +
			Math.max(this.options.minIntervalMs(), (payload.length * 1000) / this.options.targetBytesPerSecond());
		this.options.deliver(payload);
	}

	private arm(ms: number): void {
		if (this.timer !== undefined) return;
		const schedule = this.options.schedule ?? ((run, delay) => setTimeout(run, delay));
		this.timer = schedule(() => {
			this.timer = undefined;
			this.publish(false);
		}, ms);
	}

	private clearTimer(): void {
		const timer = this.timer;
		this.timer = undefined;
		if (timer === undefined) return;
		if (this.options.unschedule !== undefined) this.options.unschedule(timer);
		else clearTimeout(timer);
	}
}
