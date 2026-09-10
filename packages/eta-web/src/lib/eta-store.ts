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
 * - `views`, front session only: reconciled, keyed by `entryId`, so message objects
 *   survive a frame and `<For>` keeps its rows. A patch is written field by field
 *   instead, so only the fields that moved notify. Sessions that are not in front
 *   are held as the plain parsed object they arrived as (`buffered`) and reconciled
 *   once, on the jump to the front — walking a transcript nobody can see is what
 *   made a background tab cost as much as the visible one.
 * - `sessions`: reconciled by `name`. The server re-sends the whole sidebar list
 *   after every op, and replacing it wholesale hands `<For>` a new object per row,
 *   which re-creates the row and takes whatever local state it held (an open ⋯
 *   menu) down with it.
 * - `dev`: reconciled by a client-assigned `id`, so the log rail keeps its rows.
 *   LogRail's pause freezes the list it is showing, which is enough: a dev frame is
 *   written once and never revised.
 *
 * Everything else replaces wholesale — a handful of scalars.
 */

import { createStore, produce, reconcile } from "solid-js/store";
import type { SessionView } from "@eta/core";
import {
	HEAVY_VIEW_FIELDS,
	type ClientMessage,
	type DevFrame,
	type ServerMessage,
	type SessionViewPatch,
	type SidebarSession,
} from "./protocol.ts";

const DEV_CAP = 512;

export interface EtaState {
	connected: boolean;
	sessions: SidebarSession[];
	attach: string | null;
	views: Record<string, SessionView>;
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
	dev: {},
	unread: [],
	runningBySession: {},
	error: null,
};

/** Pure reducer, exported for tests: fold one server frame into the state. */
export function reduceEtaState(state: EtaState, message: ServerMessage): EtaState {
	if ("channel" in message) {
		if (message.channel === "view") {
			const previous = state.views[message.session];
			if (!("view" in message)) {
				// A patch with nothing to patch onto: this client never took the whole
				// frame, so there is no transcript to hold the fields still missing. Drop
				// it — the next frame that moves the journal is a whole one, and that
				// resyncs. Patches never grow the transcript, so an unread dot waits for
				// the whole frame that says so.
				if (previous === undefined) return state;
				const merged: SessionView = { ...previous, ...message.patch };
				return { ...state, views: { ...state.views, [message.session]: merged } };
			}
			const view = message.view;
			const grew = previous !== undefined && view.messages.length > previous.messages.length;
			const unseen = grew && message.session !== state.attach && !state.unread.includes(message.session);
			return {
				...state,
				views: { ...state.views, [message.session]: view },
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
 * Which session the UI shows: the focus pointer, else the first session. Same rule
 * `sessions-page.tsx` uses to pick what to render — the mirror has to agree with
 * it, or the panel waits for a frame that was only ever buffered.
 */
function frontSession(state: EtaState): string | null {
	return state.attach ?? state.sessions[0]?.name ?? null;
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
	/**
	 * Newest frame of every session that is not in front, held as the parsed object
	 * it arrived as. Reconciling a view walks every message in it, and a long
	 * session's frame is megabytes: mirroring all four sessions made the ones you
	 * are not looking at cost as much as the one you are, which is what made the
	 * tab deaf to a click. These cost a map write, and get reconciled in — once —
	 * when their session comes to the front.
	 */
	const buffered = new Map<string, SessionView>();
	for (const [name, view] of Object.entries(first.views)) {
		if (name === mirrored) continue;
		buffered.set(name, view);
	}
	const frontView = mirrored === null ? undefined : first.views[mirrored];
	const [state, setState] = createStore<EtaState>({
		...first,
		views: frontView === undefined ? {} : { [mirrored!]: frontView },
	});
	/**
	 * Fold a patch into the mirrored view, one field at a time: a frame that moved
	 * `usage` alone notifies the usage row and nothing else, and the arrays inside
	 * the patch keep their item identity.
	 *
	 * A patch is authoritative for every field except the transcript, so a field it
	 * does not mention is gone — that is how `streaming` leaves when a run ends.
	 */
	function applyPatch(session: string, patch: SessionViewPatch): void {
		// Nothing to fold onto — the same rule the reducer applies: a patch is never
		// allowed to stand in for a whole view, because half a view is a crash in
		// whatever renders `view.messages` next.
		if (state.views[session] === undefined) {
			// The patch assumes a transcript this mirror never received (a dropped
			// frame, a session that went background mid-run): ask for the whole view
			// rather than silently dropping the update and showing an empty session.
			store.send({ op: "resync", session });
			return;
		}
		// One mutation, not one per field: a half-applied patch must never be
		// observable, and a path write that trips over a mid-frame mutation takes
		// the whole subscribe loop — and every frame after it — down with it.
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

	/** Last snapshot folded in, kept raw so unchanged sessions can be skipped. */
	let applied = first;
	store.subscribe((frame) => {
		const next = store.snapshot();
		const patched =
			frame !== undefined && "channel" in frame && frame.channel === "view" && "patch" in frame ? frame : undefined;
		const front = frontSession(next);
		if (front !== mirrored) {
			// Leaving a session leaves its mirrored copy alone: keeping it costs nothing
			// and coming back reconciles from where it stopped. Entering one jumps it to
			// the newest frame that arrived while it sat in the background.
			const fresh = front === null ? undefined : buffered.get(front);
			if (front !== null && fresh !== undefined) {
				setState("views", front, reconcile(fresh, { key: "entryId" }));
				buffered.delete(front);
			}
			mirrored = front;
			// The buffered copy may trail the server's patch baseline: whatever just
			// came to the front, sign it off with a full frame.
			if (front !== null) store.send({ op: "resync", session: front });
		}
		if (next.views !== applied.views) {
			for (const name of Object.keys(applied.views)) {
				if (next.views[name] === undefined) {
					setState(
						produce((draft) => {
							delete draft.views[name];
						}),
					);
					buffered.delete(name);
				}
			}
			for (const [name, view] of Object.entries(next.views)) {
				if (applied.views[name] === view) continue;
				if (name !== mirrored) {
					buffered.set(name, view);
					continue;
				}
				if (patched !== undefined && patched.session === name) applyPatch(name, patched.patch);
				else setState("views", name, reconcile(view, { key: "entryId" }));
				buffered.delete(name);
			}
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
		const { views: _views, sessions: _sessions, dev: _dev, ...rest } = next;
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
