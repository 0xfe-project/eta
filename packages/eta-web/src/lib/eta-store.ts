/**
 * The single connection and the single store: one WebSocket, one Solid store, one
 * subscription shared by every component that reads state.
 *
 * Two frames describe a session. The first one a socket gets for a session is the
 * whole `SessionView`; while the journal does not move, the frames that follow
 * carry a `patch` — that view with the transcript left out. The split is the whole
 * reason a long session stays clickable: a streamed token changes one block of
 * text and a handful of counters, and it used to cost a fresh megabyte per token,
 * parsed and walked on the main thread twenty times a second.
 *
 * What happens to each piece:
 *
 * - `views`: the session in front only. Reconciled, keyed by `entryId`, so message
 *   objects survive a frame and `<For>` keeps its rows; a patch is written field
 *   by field so only the fields that moved notify. A session that leaves the
 *   front is evicted to a stub — `{ version, messageCount }` — and the transcript
 *   it held is gone; coming back resyncs the whole view.
 * - `stubs`: every session that is not in front, held as version + transcript
 *   length. That is all the memory a background session costs, and it is what
 *   makes the unread dot work without walking a transcript nobody can see.
 * - `sessions`: reconciled by `name`, so the sidebar keeps its rows.
 * - `dev`: reconciled by a client-assigned `id`, so the log rail keeps its rows.
 *
 * Everything else replaces wholesale — a handful of scalars.
 */

import { createStore, produce, reconcile } from "solid-js/store";
import {
	HEAVY_VIEW_FIELDS,
	type ClientMessage,
	type DevFrame,
	type ServerMessage,
	type SessionView,
	type SessionViewPatch,
	type SidebarSession,
} from "@eta/core";

const DEV_CAP = 512;

export interface EtaState {
	connected: boolean;
	sessions: SidebarSession[];
	attach: string | null;
	/** The session in front, held as a whole view; every other session is a stub. */
	views: Record<string, SessionView>;
	/** Version + transcript length of each session not in front, for unread and resync. */
	stubs: Record<string, { version: number; messageCount: number }>;
	dev: Record<string, DevFrame[]>;
	unread: string[];
	runningBySession: Record<string, boolean>;
	error: string | null;
}

export const initialEtaState: EtaState = {
	connected: false,
	sessions: [],
	attach: null,
	views: {},
	stubs: {},
	dev: {},
	unread: [],
	runningBySession: {},
	error: null,
};

/** Which session the UI shows: the focus pointer, else the first session. */
function frontSession(state: EtaState): string | null {
	return state.attach ?? state.sessions[0]?.name ?? null;
}

/** Pure reducer, exported for tests: fold one server frame into the state. */
export function reduceEtaState(state: EtaState, message: ServerMessage): EtaState {
	if ("channel" in message) {
		if (message.channel === "view") {
			const front = frontSession(state);
			if (!("view" in message)) {
				// A patch never carries the transcript. For a background session the
				// stub just advances its version; for the front it folds onto the whole
				// view, or is dropped when there is no whole view behind it.
				if (message.session !== front) {
					const stub = state.stubs[message.session];
					if (stub === undefined) return state;
					return { ...state, stubs: { ...state.stubs, [message.session]: { ...stub, version: message.version } } };
				}
				const previous = state.views[message.session];
				if (previous === undefined) return state;
				return { ...state, views: { ...state.views, [message.session]: { ...previous, ...message.patch } } };
			}
			const view = message.view;
			if (message.session === front) {
				return { ...state, views: { [message.session]: view } };
			}
			// A background whole frame becomes a stub: the transcript is not kept.
			const total = view.messages.length + (view.messagesBefore ?? 0);
			const stub = state.stubs[message.session];
			const stale = state.views[message.session];
			const prevTotal =
				stub?.messageCount ?? (stale === undefined ? 0 : stale.messages.length + (stale.messagesBefore ?? 0));
			const unseen = total > prevTotal && !state.unread.includes(message.session);
			const views = { ...state.views };
			delete views[message.session];
			return {
				...state,
				views,
				stubs: { ...state.stubs, [message.session]: { version: message.version, messageCount: total } },
				unread: unseen ? [...state.unread, message.session] : state.unread,
			};
		}
		if (message.channel === "dev") {
			const existing = state.dev[message.frame.session] ?? [];
			return {
				...state,
				dev: { ...state.dev, [message.frame.session]: [...existing, message.frame].slice(-DEV_CAP) },
			};
		}
		return state;
	}
	switch (message.type) {
		case "hello":
			return {
				...state,
				connected: true,
				sessions: message.sessions,
				attach: state.sessions.length > 0 ? state.attach : message.attach,
				views: {},
				stubs: {},
				dev: {},
				error: null,
			};
		case "sessions": {
			const runningNow: Record<string, boolean> = {};
			for (const session of message.sessions) runningNow[session.name] = session.badges.includes("running");
			return { ...state, sessions: message.sessions, runningBySession: runningNow };
		}
		case "error":
			return { ...state, error: message.message };
		default:
			return state;
	}
}

export class EtaStore {
	private state: EtaState = initialEtaState;
	private readonly listeners = new Set<(frame: ServerMessage | undefined) => void>();
	private socket: WebSocket | undefined;
	private retryMs = 500;
	private closed = false;
	/** Stamps dev frames so the rail can reconcile its list by key. */
	private devSeq = 0;

	private readonly url: string;

	constructor(url: string) {
		this.url = url;
	}

	connect(): void {
		if (this.closed) return;
		const socket = new WebSocket(this.url);
		this.socket = socket;
		socket.addEventListener("open", () => {
			this.retryMs = 500;
			this.patch({ connected: true });
		});
		socket.addEventListener("close", () => {
			this.patch({ connected: false });
			const delay = this.retryMs;
			this.retryMs = Math.min(this.retryMs * 2, 5000);
			setTimeout(() => this.connect(), delay);
		});
		socket.addEventListener("error", () => socket.close());
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as ServerMessage;
			if ("channel" in message && message.channel === "dev") {
				this.devSeq += 1;
				message.frame.id = this.devSeq;
			}
			this.state = reduceEtaState(this.state, message);
			if ("channel" in message && message.channel === "view") {
				window.dispatchEvent(new CustomEvent("eta:view", { detail: { session: message.session } }));
			}
			if ("type" in message && message.type === "personas") window.dispatchEvent(new CustomEvent("eta:personas"));
			this.emit(message);
		});
	}

	send(message: ClientMessage): void {
		if (message.op === "focus") {
			this.state = {
				...this.state,
				attach: message.session,
				unread: this.state.unread.filter((name) => name !== message.session),
			};
			this.emit();
		}
		if (this.socket !== undefined && this.socket.readyState === 1) this.socket.send(JSON.stringify(message));
	}

	dispose(): void {
		this.closed = true;
		this.socket?.close();
	}

	/** Listeners are told which frame caused the change, when a frame caused it. */
	subscribe(listener: (frame: ServerMessage | undefined) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	snapshot(): EtaState {
		return this.state;
	}

	private patch(partial: Partial<EtaState>): void {
		this.state = { ...this.state, ...partial };
		this.emit();
	}

	private emit(frame?: ServerMessage): void {
		for (const listener of [...this.listeners]) listener(frame);
	}
}

let instance: EtaStore | undefined;

export function etaStore(): EtaStore {
	if (instance === undefined) {
		const proto = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
		const host = typeof window !== "undefined" ? window.location.host : "127.0.0.1:5173";
		// The query is the capability declaration the server's patch pacing reads:
		// a tab on an older bundle that never sends it keeps getting whole views.
		instance = new EtaStore(`${proto}//${host}/ws?viewPatch`);
		instance.connect();
	}
	return instance;
}

/**
 * The one mirror of the connection, built on first use. Every `useEta()` used to
 * create its own store and its own subscription, so a single frame was folded in
 * once per component reading state — eight on the sessions page, each walking the
 * whole view. One mirror, read by all, folded into once.
 */
let mirror: EtaState | undefined;
/** Detaches the visibility listener of the current mirror; set again on every rebuild. */
let visibilityDetach: (() => void) | undefined;

function buildMirror(): EtaState {
	visibilityDetach?.();
	const store = etaStore();
	const first = store.snapshot();
	let mirrored = frontSession(first);
	let mirroredView = mirrored === null ? undefined : first.views[mirrored];
	const [state, setState] = createStore<EtaState>({
		...first,
		views: mirroredView === undefined ? {} : { [mirrored!]: mirroredView },
	});

	/**
	 * Fold a patch into the mirrored view, one field at a time: a frame that moved
	 * `usage` alone notifies the usage row and nothing else, and the arrays inside
	 * the patch keep their item identity. A patch is authoritative for every field
	 * except the transcript, so a field it does not mention is gone.
	 */
	function applyPatch(session: string, patch: SessionViewPatch): void {
		// Nothing to fold onto: the transcript was evicted on the way out. Ask for
		// the whole view rather than painting half a view over the components.
		if (state.views[session] === undefined) {
			store.send({ op: "resync", session });
			return;
		}
		const heavy = HEAVY_VIEW_FIELDS as readonly string[];
		setState(
			"views",
			session,
			produce((view: SessionView) => {
				const row = view as unknown as Record<string, unknown>;
				for (const [key, value] of Object.entries(patch)) row[key] = value;
				for (const key of Object.keys(row)) {
					if (key in patch || heavy.includes(key)) continue;
					delete row[key];
				}
			}),
		);
	}

	/** Last snapshot folded in, kept raw so unchanged sessions and lists can be skipped. */
	let applied = first;
	store.subscribe((frame) => {
		const next = store.snapshot();
		const patched =
			frame !== undefined && "channel" in frame && frame.channel === "view" && "patch" in frame ? frame : undefined;
		const front = frontSession(next);
		if (front !== mirrored) {
			mirrored = front;
			mirroredView = front === null ? undefined : next.views[front];
			// The session we leave is evicted; the one we enter is a stub until its
			// whole frame lands, so ask for it now.
			setState(
				produce((draft) => {
					draft.views = {};
				}),
			);
			if (front !== null) store.send({ op: "resync", session: front });
		}
		const view = front === null ? undefined : next.views[front];
		if (view !== mirroredView) {
			if (view === undefined) {
				// The front's whole view is gone (reconnect cleared it, or the session
				// was deleted): drop whatever was mirrored rather than holding a stale one.
				setState(
					produce((draft) => {
						draft.views = {};
					}),
				);
			} else if (patched !== undefined && patched.session === front && mirroredView !== undefined) {
				applyPatch(front, patched.patch);
			} else {
				setState("views", front as string, reconcile(view, { key: "entryId" }));
			}
			mirroredView = view;
		}
		if (next.sessions !== applied.sessions) setState("sessions", reconcile(next.sessions, { key: "name" }));
		if (next.dev !== applied.dev) {
			for (const name of Object.keys(applied.dev)) {
				if (next.dev[name] === undefined) {
					setState(
						produce((draft) => {
							delete draft.dev[name];
						}),
					);
				}
			}
			for (const [name, frames] of Object.entries(next.dev)) {
				if (applied.dev[name] === frames) continue;
				// Keyed on the id stamped at fold time: an appended frame is one write at
				// the tail, not a new array for the rail to diff away.
				setState("dev", name, reconcile(frames, { key: "id" }));
			}
		}
		const { views: _views, sessions: _sessions, dev: _dev, stubs: _stubs, ...rest } = next;
		setState(rest);
		applied = next;
	});
	// A backgrounded tab can miss frames while its socket stalls; resync the
	// session in front the moment the tab is visible again.
	const onVisible = () => {
		if (document.visibilityState === "visible" && mirrored !== null) store.send({ op: "resync", session: mirrored });
	};
	document.addEventListener("visibilitychange", onVisible);
	visibilityDetach = () => document.removeEventListener("visibilitychange", onVisible);
	// The mirror outlives every component that reads it, so there is nothing to
	// unsubscribe from: `resetEtaStoreForTests` drops the store and the mirror
	// together.
	mirror = state;
	return state;
}

export function useEta(): EtaState {
	if (mirror !== undefined) return mirror;
	return buildMirror();
}

export function useEtaOps() {
	const store = etaStore();
	return {
		send: (message: ClientMessage) => store.send(message),
	};
}

/** Test-only: drop the module singletons so the next `useEta()` reconnects. */
export function resetEtaStoreForTests(): void {
	instance?.dispose();
	instance = undefined;
	mirror = undefined;
}
