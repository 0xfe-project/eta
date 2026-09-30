/**
 * The transport: one WebSocket, and the rules that make it usable (SERVER-REFACTOR.md §4).
 *
 * Two layers live here, on purpose:
 *
 * - **The session state machine** (`createConnection`), which knows nothing about
 *   sockets-as-objects: it takes a `Socket` and a `deps` seam, so the ordering,
 *   hello, resync and error paths are testable with a fake socket — no server, no
 *   port, no timing.
 * - **The Bun binding** (`serveWire`), which is the only file in the repo that knows
 *   what Bun's WebSocket handler looks like. Everything it does is call the state
 *   machine; if it ever grows a rule, the rule is in the wrong layer.
 *
 * The rules themselves:
 *
 * - **Ops from one connection apply strictly in arrival order.** A client sends
 *   `prompt` then `abort`; if those race, the abort lands before the run starts and
 *   the user watches their cancellation be ignored. So each socket has a tail promise
 *   and every op chains onto it.
 * - **The transport routes nothing.** Every message goes to one `dispatch` seam —
 *   session ops, plugin ops and the shell's `native` alike — because a router with a
 *   special case per message kind is a router that has to change when a plugin is
 *   added. Which ops exist, and who owns them, is the router's business (S10).
 * - **`resync` is a read, answered on this socket alone**, and it re-points that
 *   socket's patch baseline at what it just sent — otherwise the next patch frame
 *   would be a delta against a view the client never had.
 * - **A bad frame is an error frame, not a disconnect**: a client that sends garbage
 *   gets told, and keeps its session.
 * - **`native` is a broadcast**, because the shell that clicked a menu item is a
 *   client like any other and every attached page wants to see it.
 */
import {
	type ClientMessage,
	decodeClientMessage,
	type MountedPlugin,
	type ServerMessage,
	type SessionModelOption,
	type SessionView,
	type SidebarSession,
} from "@eta/wire";

/** What one connected client looks like to this file. */
export interface Socket {
	readonly id: number;
	send(message: ServerMessage): void;
}

/** What the transport needs from the host it belongs to. */
export interface TransportDeps {
	/** The rows a sidebar draws, cheaply: no session is opened to produce them. */
	sidebar(): SidebarSession[];
	/** The models a session may be switched to. */
	models(): SessionModelOption[];
	personas(): string[];
	mounted(): MountedPlugin[];
	/** The session the client should be looking at, if any. */
	attach(): string | null;
	/**
	 * Apply one message. Resolves to what it brought into or took out of the world, so
	 * the transport can announce it; a message with neither is silent.
	 */
	dispatch(message: ClientMessage): Promise<DispatchOutcome>;
	/** The whole current view for one session, for a resync. */
	viewOf(session: string): { version: number; view: SessionView } | undefined;
	/** This socket now holds that exact view: the frames that follow may omit it. */
	rememberView(socket: Socket, session: string, view: SessionView): void;
	/** Send this frame to every connected client (`native`, a model change, goodbye). */
	broadcast?(message: ServerMessage): void;
	/** A socket went away (the host drops its patch bookkeeping here). */
	onClose?(socket: Socket): void;
	/** Called with anything the transport itself cannot report (`onError` of a send). */
	warn?(message: string): void;
}

export interface Connection {
	/** Feed one raw frame from the client. */
	handle(raw: string): Promise<void>;
	/** Send a frame to this client (a host-pushed view, an agent event, a plugin frame). */
	send(message: ServerMessage): void;
	close(): void;
}

/** Everything that is true of one connection, with no socket library involved. */
export function createConnection(socket: Socket, deps: TransportDeps): Connection {
	let tail: Promise<void> = Promise.resolve();
	let closed = false;

	const send = (message: ServerMessage): void => {
		if (closed) return;
		try {
			socket.send(message);
		} catch (error) {
			deps.warn?.(`[eta-server] send to socket ${socket.id} failed: ${String(error)}`);
		}
	};

	// hello first: a client that has not been told what exists cannot assemble itself.
	send({
		type: "hello",
		sessions: deps.sidebar(),
		attach: deps.attach(),
		models: deps.models(),
		personas: deps.personas(),
		mounted: deps.mounted(),
	});

	const applyOne = async (message: ClientMessage): Promise<void> => {
		// A resync answers this socket alone and re-points its patch baseline.
		if (message.op === "resync") {
			const current = deps.viewOf(message.session);
			if (current !== undefined) {
				deps.rememberView(socket, message.session, current.view);
				send({ channel: "view", session: message.session, version: current.version, view: current.view });
			}
			return;
		}
		const outcome = await deps.dispatch(message);
		if (outcome.broadcast !== undefined) deps.broadcast?.(outcome.broadcast);
		if (outcome.created !== undefined) send({ type: "created", session: outcome.created });
		if (outcome.deleted !== undefined) send({ type: "deleted", session: outcome.deleted });
		if (outcome.silent === true) return;
		// The list is cheap and the client is looking at it: every op that changed
		// something re-states the truth rather than asking the client to patch its own
		// copy without knowing the rules.
		send({ type: "sessions", sessions: deps.sidebar() });
	};

	return {
		async handle(raw: string): Promise<void> {
			let message: ClientMessage;
			try {
				message = decodeClientMessage(raw);
			} catch {
				send({ type: "error", message: "bad frame" });
				return;
			}
			const run = async (): Promise<void> => {
				try {
					await applyOne(message);
				} catch (error) {
					send({ type: "error", message: error instanceof Error ? error.message : String(error) });
				}
			};
			// Strict ordering per connection: the next op waits for this one, whichever
			// way it settled.
			const chained = tail.then(run, run);
			tail = chained;
			await chained;
		},
		send,
		close(): void {
			closed = true;
			deps.onClose?.(socket);
		},
	} as Connection;
}

/** What one applied message did, for the two frames the transport owes the client. */
export interface DispatchOutcome {
	created?: string | undefined;
	deleted?: string | undefined;
	/** A frame the handler wants sent to every client (a model change, a native relay). */
	broadcast?: ServerMessage | undefined;
	/** The handler answered for itself: no "here is the session list" follow-up. */
	silent?: boolean | undefined;
}

/**
 * The Bun side: one WebSocket endpoint, one connection object per client.
 *
 * Everything here is plumbing — id assignment, the socket table, the fan-out — and
 * deliberately nothing else: the rules live in `createConnection`, so they are tested
 * without a port.
 */
export interface WireServerOptions {
	port: number;
	/** Where the UI is served from, when there is one (a Bun HTML bundle). */
	staticRoutes?: Record<string, () => Response | Promise<Response>>;
	/** Frames the UI needs from the host (views, agent events, plugin frames). */
	onHostFrame?: (send: (message: ServerMessage) => void) => void;
}

export interface WireServer {
	readonly port: number;
	/** Send a frame to every connected client. */
	broadcast(message: ServerMessage): void;
	/** How many clients are attached (the pacer cares). */
	readonly clients: number;
	stop(): void;
}

export function serveWire(deps: TransportDeps, options: WireServerOptions): WireServer {
	const connections = new Map<number, Connection>();
	let nextId = 1;

	const push = (message: ServerMessage | string): void => {
		for (const connection of connections.values()) {
			connection.send(typeof message === "string" ? (JSON.parse(message) as ServerMessage) : message);
		}
	};
	const withBroadcast: TransportDeps = { ...deps, broadcast: push };

	const server = Bun.serve<{ socket: Socket }>({
		port: options.port,
		fetch(request, bunServer) {
			const path = new URL(request.url).pathname;
			const route = options.staticRoutes?.[path];
			if (route !== undefined) return route();
			if (path !== "/ws") return new Response("not found", { status: 404 });
			if (bunServer.upgrade(request, { data: { socket: { id: 0, send: () => undefined } } })) return undefined;
			return new Response("websocket upgrade failed", { status: 400 });
		},
		websocket: {
			open(raw) {
				const id = nextId++;
				const socket: Socket = {
					id,
					send: (message) => {
						raw.send(encodeFrame(message));
					},
				};
				const connection = createConnection(socket, withBroadcast);
				raw.data = { socket };
				connections.set(id, connection);
			},
			async message(raw, body) {
				const connection = connections.get(raw.data.socket.id);
				if (connection === undefined) return;
				await connection.handle(typeof body === "string" ? body : new TextDecoder().decode(body));
			},
			close(raw) {
				const connection = connections.get(raw.data.socket.id);
				connections.delete(raw.data.socket.id);
				connection?.close();
			},
		},
	});

	return {
		port: server.port ?? options.port,
		broadcast: push,
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

/** One frame on the wire. Kept here so the codec stays a single import. */
function encodeFrame(message: ServerMessage): string {
	return JSON.stringify(message);
}
