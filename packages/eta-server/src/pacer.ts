/**
 * The frame budget: how often a target's state may reach one socket.
 *
 * Without this, every event in a run pushes a state frame, and a streaming turn pushes one per
 * token — each of them a fresh look at the whole view. Measured on eta-agent's own sessions,
 * that put 42MB/s on the wire to one tab, and the tab spent its main thread re-reconciling a
 * view in which one character had moved.
 *
 * So a push does not send. It *marks*, and the frame that goes out is the newest state at the
 * moment the floor allows one — with the floor paid for by size: a frame of N bytes buys
 * `N / targetBytesPerSecond` milliseconds of quiet. The result is that the wire carries a
 * bounded number of bytes per second no matter how long the session is or how fast it streams,
 * and the client always gets the *latest* state rather than a queue of stale ones.
 *
 * Three properties are worth naming:
 *
 * - **The floor is dynamic.** Which session the user is looking at changes while it runs, so
 *   `minIntervalMs()` is read at publish time: the session in front streams tightly, the ones
 *   behind settle for a few updates a second.
 * - **The last state always lands.** A trailing timer means the frame that says "the run
 *   ended" cannot be dropped just because the floor was not up yet.
 * - **Nothing is lost.** Coalescing drops *intermediate* frames; the state each of them carried
 *   is a projection of the same source, and the one that goes out is the newest.
 */
import type { ServerFrame } from "@eta/client-wire-proto";

export interface PacerOptions {
	/** The floor between two frames for this socket, read at publish time. */
	minIntervalMs(): number;
	/** The wire budget, in bytes per second. A frame of N bytes buys `N / this` ms of quiet. */
	targetBytesPerSecond?: number;
	/** Ask the sender what this socket is owed, and account for it. `undefined` = nothing. */
	next(): { frame: ServerFrame; bytes: number } | undefined;
	/** Put the frame on the socket. */
	deliver(frame: ServerFrame): void;
	now?: () => number;
	schedule?: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
	unschedule?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** One socket's budget for one target. */
export class FramePacer {
	private readonly options: PacerOptions;
	private readonly now: () => number;
	private dirty = false;
	private nextAt = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	constructor(options: PacerOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	/** The state moved. Send now if the floor is up, otherwise coalesce into the next frame. */
	mark(): void {
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
	 * Send without waiting for the floor — a user did something, a run ended, a client just
	 * attached. Still one frame: everything coalesced so far rides out together.
	 */
	flush(): void {
		if (this.disposed) return;
		this.dirty = true;
		this.publish(true);
	}

	/** Forget the accumulated quiet: the next frame goes out as soon as there is one. */
	relax(): void {
		this.nextAt = 0;
	}

	/**
	 * Account for a frame this pacer did not send — the snapshot a new subscriber gets, which
	 * goes out immediately because the alternative is an empty panel. A big snapshot buys its
	 * quiet like any other frame; otherwise the floor restarts at zero and the client that just
	 * arrived collects a burst.
	 */
	spent(bytes: number): void {
		const budget = this.options.targetBytesPerSecond ?? DEFAULT_BYTES_PER_SECOND;
		this.nextAt = this.now() + Math.max(this.options.minIntervalMs(), (bytes * 1000) / budget);
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
		let owed: { frame: ServerFrame; bytes: number } | undefined;
		try {
			owed = this.options.next();
		} catch {
			// A projection that throws must not take the event dispatch down with it: stay dirty
			// and try again on the next change.
			this.arm(this.options.minIntervalMs());
			return;
		}
		this.dirty = false;
		if (owed === undefined) return;
		const delivered = this.now();
		const budget = this.options.targetBytesPerSecond ?? DEFAULT_BYTES_PER_SECOND;
		this.nextAt = delivered + Math.max(this.options.minIntervalMs(), (owed.bytes * 1000) / budget);
		this.options.deliver(owed.frame);
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

/** 4MB/s: a long transcript's patch is tens of KB, which buys tens of milliseconds. */
export const DEFAULT_BYTES_PER_SECOND = 4_000_000;

/** How tightly the session in front streams. */
export const FOCUSED_INTERVAL_MS = 100;
/** How often a session nobody is looking at updates. */
export const BACKGROUND_INTERVAL_MS = 600;
