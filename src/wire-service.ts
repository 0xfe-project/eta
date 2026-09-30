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
	readonly push: (target: string) => void;
	readonly event: (target: string, name: string, data: unknown) => void;
	readonly descriptors: () => OpDescriptor[];
	readonly targets: () => TargetSummary[];
	readonly snapshot: (target: string) => StateSnapshot | undefined;
	readonly subscribe: (socketId: number, target: string) => void;
	readonly unsubscribe: (socketId: number, target: string) => void;
	readonly dispatch: (call: CallFrame, context: OpContext) => Promise<DispatchOutcome>;
	/** Send a frame to every connected client (the shell's native relay, a version notice). */
	readonly broadcast: (frame: ServerFrame) => void;
	readonly attachSink: (sink: FrameSink | undefined) => void;

	constructor(ctx: Context, options: WireServiceOptions = {}) {
		super(ctx, "wire");
		const warn = options.warn ?? (() => undefined);
		const registry = createTargetRegistry();
		const state = createStateSender({ snapshot: (target) => registry.snapshot(target), warn });
		let sink: FrameSink | undefined;

		this.registry = registry;
		this.state = state;
		this.attachSink = (next) => {
			sink = next;
		};
		this.handle = (target, action, handler, meta) => registry.handle(target, action, handler, meta);
		this.stateOf = (target, projector) => registry.state(target, projector);
		this.push = (target) => {
			// The target rides along: a frame's destination is the subscribers of that target,
			// and a sink that only saw a socket id could not say which target moved.
			for (const addressed of state.push(target)) {
				sink?.({ frame: addressed.frame, socketId: addressed.socketId, target });
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
			for (const owed of state.subscribe(socketId, target)) sink?.({ frame: owed, socketId });
		};
		this.unsubscribe = (socketId, target) => {
			state.unsubscribe(socketId, target);
		};
		this.dispatch = (call, opContext) => registry.dispatch(call, opContext);
		this.broadcast = (frame) => {
			sink?.({ frame });
		};
	}
}
