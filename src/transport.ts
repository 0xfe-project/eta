/**
 * The pipe: one WebSocket, and the rules that make it usable (SERVER-REFACTOR.md §3/§4).
 *
 * Two layers, on purpose: the connection rules (a `Socket` and a `deps` seam, so they are
 * tested with a fake socket) and the Bun binding (`serveWire`), the only file in the repo
 * that knows what Bun's WebSocket handler looks like.
 *
 * The transport knows four words — call, subscribe, unsubscribe, native — and no feature.
 * It routes a call to the target registry, hands a subscription to the state sender, and
 * fans a native frame out. What a client *can* call is whatever is registered, which is
 * what `hello` says.
 *
 * The rules, each from a way this goes wrong:
 *
 * - **Frames from one connection apply strictly in arrival order.** A client sends `prompt`
 *   then `abort`; if those race, the abort lands before the run starts and the user watches
 *   their cancellation be ignored. So each socket has a tail promise.
 * - **A call with a requestId gets a reply, whichever way it settled.** Fire-and-forget
 *   calls (no requestId) get none, which is what makes them cheap.
 * - **A bad frame is an error frame, not a disconnect** — a client that sends garbage is
 *   told so and keeps its session.
 * - **hello is the first frame**: the ops, the mounted plugins, and the state of every eager
 *   target, so a client that just connected can draw before it asks for anything.
 */
import {
	type CallFrame,
	type ClientFrame,
	decodeClientFrame,
	encodeFrame,
	type OpDescriptor,
	type ServerFrame,
} from "@eta/client-wire-proto";
import { type DispatchOutcome, type OpContext, UnknownOpError } from "./registry";
import type { WireService } from "./wire-service";

/** What one connected client looks like to this file. */
export interface Socket {
	readonly id: number;
	send(frame: ServerFrame): void;
}

/**
 * What the pipe needs: the wire service (registry + state + routing decisions) and the two
 * things only the pipe can answer — who is connected, and what plugins exist.
 */
export interface TransportDeps {
	wire: WireService;
	mounted(): import("@eta/client-wire-proto").MountedPlugin[];
	/** Diagnostics. */
	warn?(message: string): void;
}

export interface Connection {
	/** Feed one raw frame from the client. */
	handle(raw: string): Promise<void>;
	/** Send a frame to this client (a pushed state, an event). */
	send(frame: ServerFrame): void;
	close(): void;
}

/** Everything that is true of one connection, with no socket library involved. */
export function createConnection(socket: Socket, deps: TransportDeps): Connection {
	let tail: Promise<void> = Promise.resolve();
	let closed = false;

	const send = (frame: ServerFrame): void => {
		if (closed) return;
		try {
			socket.send(frame);
		} catch (error) {
			deps.warn?.(`[eta-server] send to socket ${socket.id} failed: ${String(error)}`);
		}
	};

	// hello first: a client that has not been told what exists cannot assemble itself.
	const hello: ServerFrame = {
		type: "hello",
		ops: deps.wire.descriptors(),
		mounted: deps.mounted(),
		// Every eager target's state, so a client that just connected draws without asking.
		state: Object.fromEntries(
			deps.wire.registry
				.eagerTargets()
				.map((target: string) => [target, deps.wire.snapshot(target)] as const)
				.filter(
					(entry): entry is readonly [string, NonNullable<ReturnType<WireService["snapshot"]>>] =>
						entry[1] !== undefined,
				),
		),
	};
	send(hello);

	const context = (_call: CallFrame): OpContext => ({
		reply: (frame) => {
			// A handler that answers for itself may bypass the generic reply; it is the same
			// socket either way.
			send(frame);
		},
	});

	const applyOne = async (frame: ClientFrame): Promise<void> => {
		if (frame.op === "subscribe") {
			// The service decides what this socket is owed; the sink (installed by the pipe)
			// puts it on this socket.
			deps.wire.subscribe(socket.id, frame.target);
			return;
		}
		if (frame.op === "unsubscribe") {
			deps.wire.unsubscribe(socket.id, frame.target);
			return;
		}
		if (frame.op === "native") {
			// The shell that clicked is a client like any other: a native frame is an event on
			// the `native` target, which is the same fan-out as everything else — no privileged
			// server frame, and no target of its own that a subscription could filter.
			deps.wire.broadcast({
				type: "event",
				target: "native",
				name: frame.action,
				data: { kind: frame.kind, ...(frame.data === undefined ? {} : { data: frame.data }) },
			});
			return;
		}
		const requestId = frame.requestId;
		try {
			const outcome: DispatchOutcome = await deps.wire.dispatch(frame, context(frame));
			if (outcome.broadcast !== undefined) send(outcome.broadcast);
			if (requestId !== undefined) {
				send({
					type: "reply",
					requestId,
					ok: true,
					...(outcome.result === undefined ? {} : { result: outcome.result }),
				});
			}
		} catch (error) {
			const message = error instanceof UnknownOpError || error instanceof Error ? error.message : String(error);
			if (requestId === undefined) {
				// Fire-and-forget cannot be answered in place, so the failure is an error frame:
				// silence would make a typo look like a slow server.
				send({ type: "error", message });
				return;
			}
			send({ type: "reply", requestId, ok: false, error: message });
		}
	};

	return {
		async handle(raw: string): Promise<void> {
			let frame: ClientFrame;
			try {
				frame = decodeClientFrame(raw);
			} catch {
				send({ type: "error", message: "bad frame" });
				return;
			}
			const run = (): Promise<void> => applyOne(frame);
			const chained = tail.then(run, run);
			tail = chained;
			await chained;
		},
		send,
		close(): void {
			closed = true;
			deps.wire.dropSocket(socket.id);
		},
	};
}

/**
 * The Bun side: one WebSocket endpoint, one connection object per client.
 *
 * Plumbing only — id assignment, the socket table, the fan-out. The rules live above, so
 * they are tested without a port.
 */
export interface WireServerOptions {
	port: number;
	/** Where the UI is served from, when there is one. */
	staticRoutes?: Record<string, () => Response | Promise<Response>>;
}

export interface WireServer {
	readonly port: number;
	/** Send a frame to every connected client. */
	broadcast(frame: ServerFrame): void;
	/** Deliver what a target's subscribers are owed (the state sender decided). */
	pushState(target: string): void;
	readonly clients: number;
	stop(): void;
}

export function serveWire(deps: TransportDeps, options: WireServerOptions): WireServer {
	const connections = new Map<number, Connection>();
	let nextId = 1;

	/**
	 * The sink: the one place that knows which sockets exist. A frame with a `socketId` goes to
	 * that client, a frame with only a `target` goes to whoever subscribed to it, and a frame
	 * with neither is a fan-out (the shell's native relay).
	 */
	deps.wire.attachSink((addressed) => {
		if (addressed.socketId !== undefined) {
			connections.get(addressed.socketId)?.send(addressed.frame);
			return;
		}
		for (const [id, connection] of connections) {
			if (addressed.target === undefined) {
				connection.send(addressed.frame);
				continue;
			}
			if (deps.wire.state.subscriptions(id).includes(addressed.target)) connection.send(addressed.frame);
		}
	});

	const server = Bun.serve<{ socketId: number }>({
		port: options.port,
		fetch(request, bunServer) {
			const path = new URL(request.url).pathname;
			const route = options.staticRoutes?.[path];
			if (route !== undefined) return route();
			if (path !== "/ws") return new Response("not found", { status: 404 });
			if (bunServer.upgrade(request, { data: { socketId: 0 } })) return undefined;
			return new Response("websocket upgrade failed", { status: 400 });
		},
		websocket: {
			open(raw) {
				const id = nextId++;
				// The id rides on the socket's own data: Bun hands the same object back on
				// every callback, so this is how a frame finds its connection.
				raw.data.socketId = id;
				const socket: Socket = { id, send: (frame) => raw.send(encodeFrame(frame)) };
				connections.set(id, createConnection(socket, deps));
			},
			async message(raw, body) {
				const connection = connections.get(raw.data.socketId);
				if (connection === undefined) return;
				await connection.handle(typeof body === "string" ? body : new TextDecoder().decode(body));
			},
			close(raw) {
				const id = raw.data.socketId;
				const connection = connections.get(id);
				connections.delete(id);
				connection?.close();
			},
		},
	});

	return {
		port: server.port ?? options.port,
		broadcast: (frame) => {
			for (const connection of connections.values()) connection.send(frame);
		},
		pushState: (target) => deps.wire.push(target),
		get clients(): number {
			return connections.size;
		},
		stop(): void {
			for (const connection of connections.values()) connection.close();
			connections.clear();
			server.stop(true);
		},
	};
}

/** Op descriptors, for a caller that wants to log what a server offers. */
export function describeOps(ops: readonly OpDescriptor[]): string {
	return ops.map((op) => op.name).join(", ");
}
