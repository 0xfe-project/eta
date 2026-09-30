/**
 * The `wire` service: the only thing a plugin needs to exist on the wire.
 *
 * The shell owns the socket table; a plugin owns semantics. This service is the seam
 * between them — a plugin registers what its target can be asked to do and what it shows,
 * pushes its state when it moved, and emits events; the pipe delivers. So a plugin never
 * sees a socket, and the pipe never learns a feature name.
 *
 * The sink is installed by whoever starts the pipe (`serveWire`): before that, calls and
 * state still work (a test can drive them directly) and pushes go nowhere, which is the
 * honest behaviour for a server that has not opened its port yet.
 */
import type { CallFrame, OpDescriptor, ServerFrame, StateSnapshot } from "@eta/client-wire-proto";
import { type Context, Service } from "cordis";
import { BACKGROUND_INTERVAL_MS, FOCUSED_INTERVAL_MS, FramePacer } from "./pacer";
import type {
	DispatchOutcome,
	OpContext,
	OpHandler,
	OpMeta,
	StateProjector,
	TargetRegistry,
	TargetSummary,
} from "./registry";
import { createTargetRegistry } from "./registry";
import type { StateSender } from "./state-sender";
import { createStateSender } from "./state-sender";

/**
 * Where a decided frame goes. `socketId` means "this one client"; `target` alone means "whoever
 * is subscribed to that target" — and the pipe is what turns those into sockets. So the service
 * never sees a socket and the pipe never decides a frame.
 */
export type FrameSink = (addressed: { frame: ServerFrame; socketId?: number; target?: string }) => void;

export interface WireServiceOptions {
	/** Diagnostics. */
	warn?: ((message: string) => void) | undefined;
	/**
	 * The wire budget, in bytes per second. A frame of N bytes buys `N / this` ms of quiet, so
	 * a long session costs no more frames per second than a short one.
	 */
	targetBytesPerSecond?: number | undefined;
	/** The floor between frames for a target nobody is looking at. */
	backgroundIntervalMs?: number | undefined;
	/** The floor for a target somebody is looking at. */
	focusedIntervalMs?: number | undefined;
	/**
	 * The clock the frame budget is measured against. Only a test passes one: pacing is about
	 * elapsed time, and a test that cannot move time can only assert what it hopes did not
	 * happen.
	 */
	now?: (() => number) | undefined;
	schedule?: ((run: () => void, ms: number) => ReturnType<typeof setTimeout>) | undefined;
	unschedule?: ((timer: ReturnType<typeof setTimeout>) => void) | undefined;
}

export class WireService extends Service {
	static readonly provide = "wire";

	/** The registries, for the few callers that need the raw shape (the pipe, tests). */
	readonly registry: TargetRegistry;
	readonly state: StateSender;

	/**
	 * The plugin-facing API, as own properties over a closure.
	 *
	 * Deliberately not prototype methods: cordis hands a *view* of a service to anyone who
	 * asks the context for it, and a prototype method called on that view would resolve
	 * `this` to the view rather than to the instance — silently losing every field it reads.
	 * Closures have no such question to answer.
	 */
	readonly handle: (target: string, action: string, handler: OpHandler, meta?: OpMeta) => () => void;
	readonly stateOf: (target: string, projector: StateProjector) => () => void;
	/**
	 * Say that a target's state moved. The frame goes out when the budget allows one, so a
	 * burst (a streaming turn, a tool that writes as it goes) costs a bounded number of frames.
	 */
	readonly push: (target: string) => void;
	/**
	 * Say that a target's state moved *because someone just did something* — a pin, a rename,
	 * an answered question. The frame goes out now: a user who clicked a button is waiting for
	 * the result, and 600ms of silence is indistinguishable from a broken button.
	 */
	readonly pushNow: (target: string) => void;
	readonly event: (target: string, name: string, data: unknown) => void;
	readonly descriptors: () => OpDescriptor[];
	readonly targets: () => TargetSummary[];
	readonly snapshot: (target: string) => StateSnapshot | undefined;
	readonly subscribe: (socketId: number, target: string) => void;
	/**
	 * Say which targets someone is looking at. A focused target streams tightly; everything
	 * else settles for a few updates a second. The server does not know what "focused" means
	 * beyond this — a client says so, or nobody does and everything is background.
	 */
	readonly focus: (targets: readonly string[]) => void;
	readonly unsubscribe: (socketId: number, target: string) => void;
	readonly dispatch: (call: CallFrame, context: OpContext) => Promise<DispatchOutcome>;
	/** Send a frame to every connected client (the shell's native relay, a version notice). */
	readonly broadcast: (frame: ServerFrame) => void;
	readonly attachSink: (sink: FrameSink | undefined) => void;
	/** Forget a socket: its subscriptions and its pacers. */
	readonly dropSocket: (socketId: number) => void;

	constructor(ctx: Context, options: WireServiceOptions = {}) {
		super(ctx, "wire");
		const warn = options.warn ?? (() => undefined);
		const registry = createTargetRegistry();
		const state = createStateSender({ snapshot: (target) => registry.snapshot(target), warn });
		let sink: FrameSink | undefined;
		const focused = new Set<string>();
		/** One pacer per socket per target: pacing is per subscriber, because floors are. */
		const pacers = new Map<string, FramePacer>();
		const pacerKey = (socketId: number, target: string): string => `${socketId}\u0000${target}`;
		const floorFor = (target: string): number =>
			focused.has(target)
				? (options.focusedIntervalMs ?? FOCUSED_INTERVAL_MS)
				: (options.backgroundIntervalMs ?? BACKGROUND_INTERVAL_MS);
		const pacerFor = (socketId: number, target: string): FramePacer => {
			const key = pacerKey(socketId, target);
			const existing = pacers.get(key);
			if (existing !== undefined) return existing;
			const pacer = new FramePacer({
				minIntervalMs: () => floorFor(target),
				...(options.now === undefined ? {} : { now: options.now }),
				...(options.schedule === undefined ? {} : { schedule: options.schedule }),
				...(options.unschedule === undefined ? {} : { unschedule: options.unschedule }),
				...(options.targetBytesPerSecond === undefined
					? {}
					: { targetBytesPerSecond: options.targetBytesPerSecond }),
				next: () => {
					const owed = state.pending(socketId, target);
					if (owed === undefined) return undefined;
					return { frame: owed.frame, bytes: JSON.stringify(owed.frame).length };
				},
				deliver: (frame) => sink?.({ frame, socketId, target }),
			});
			pacers.set(key, pacer);
			return pacer;
		};
		const forgetPacers = (socketId: number): void => {
			for (const [key, pacer] of pacers) {
				if (!key.startsWith(`${socketId}\u0000`)) continue;
				pacer.dispose();
				pacers.delete(key);
			}
		};

		this.registry = registry;
		this.state = state;
		this.attachSink = (next) => {
			sink = next;
		};
		this.handle = (target, action, handler, meta) => registry.handle(target, action, handler, meta);
		this.stateOf = (target, projector) => registry.state(target, projector);
		// A push does not send: it marks. The frame that goes out is the newest state at the
		// moment each subscriber's floor allows one, which is what bounds the wire instead of
		// the session's length (see pacer.ts).
		this.push = (target) => {
			for (const socketId of state.watchersOf(target)) pacerFor(socketId, target).mark();
		};
		this.pushNow = (target) => {
			for (const socketId of state.watchersOf(target)) pacerFor(socketId, target).flush();
		};
		this.focus = (targets) => {
			focused.clear();
			for (const target of targets) focused.add(target);
			// A target that just came into focus should not wait out a background floor.
			for (const target of targets) {
				for (const socketId of state.watchersOf(target)) pacerFor(socketId, target).relax();
			}
		};
		this.event = (target, name, data) => {
			sink?.({ target, frame: { type: "event", target, name, data } });
		};
		this.descriptors = () => registry.descriptors();
		this.targets = () => registry.targets();
		this.snapshot = (target) => registry.snapshot(target);
		// Subscribing is one path for everybody — a real socket, a test with a made-up id:
		// the sender decides what is owed, and the pipe is told where to put it.
		this.subscribe = (socketId, target) => {
			// A client that holds nothing gets the snapshot *now*: there is no floor to respect
			// when the alternative is an empty panel. It still counts against the budget, so a
			// client that just arrived does not immediately collect a burst behind it.
			for (const owed of state.subscribe(socketId, target)) {
				sink?.({ frame: owed, socketId });
				pacerFor(socketId, target).spent(JSON.stringify(owed).length);
			}
		};
		this.unsubscribe = (socketId, target) => {
			state.unsubscribe(socketId, target);
			const pacer = pacers.get(pacerKey(socketId, target));
			pacer?.dispose();
			pacers.delete(pacerKey(socketId, target));
		};
		this.dispatch = (call, opContext) => registry.dispatch(call, opContext);
		this.broadcast = (frame) => {
			sink?.({ frame });
		};
		// A dropped socket takes its pacers with it: a timer holding a socket id nobody has any
		// more is a frame delivered to nowhere, on a schedule.
		this.dropSocket = (socketId) => {
			state.drop(socketId);
			forgetPacers(socketId);
		};
	}
}
