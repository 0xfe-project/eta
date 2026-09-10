/**
 * The single connection: one WebSocket, one store. Reconnects with backoff;
 * the server's hello + per-session view frames are the whole resync path, so
 * view state is fully replaced on (re)connect. UI reads via a Solid store
 * that replaces each snapshot (mechanical stand-in for useSyncExternalStore).
 * Do not `reconcile`: it mutates arrays in place and breaks identity freeze
 * (DevRail pause holds the previous `dev[]` snapshot).
 */

import { onCleanup } from "solid-js";
import { createStore } from "solid-js/store";
import type { SessionView } from "@eta/core";
import type { ClientMessage, DevFrame, ServerMessage, SidebarSession } from "./protocol.ts";

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
			const grew = previous !== undefined && message.view.messages.length > previous.messages.length;
			const unseen = grew && message.session !== state.attach && !state.unread.includes(message.session);
			return {
				...state,
				views: { ...state.views, [message.session]: message.view },
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
	private readonly listeners = new Set<() => void>();
	private socket: WebSocket | undefined;
	private retryMs = 500;
	private closed = false;

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
			this.state = reduceEtaState(this.state, message);
			if ("type" in message && message.type === "personas") window.dispatchEvent(new CustomEvent("eta:personas"));
			this.emit();
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

	subscribe(listener: () => void): () => void {
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

	private emit(): void {
		for (const listener of [...this.listeners]) listener();
	}
}

let instance: EtaStore | undefined;

export function etaStore(): EtaStore {
	if (instance === undefined) {
		const proto = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
		const host = typeof window !== "undefined" ? window.location.host : "127.0.0.1:5173";
		instance = new EtaStore(`${proto}//${host}/ws`);
		instance.connect();
	}
	return instance;
}

export function useEta(): EtaState {
	const store = etaStore();
	const [state, setState] = createStore(store.snapshot());
	const unsubscribe = store.subscribe(() => {
		setState(store.snapshot());
	});
	onCleanup(unsubscribe);
	return state;
}

export function useEtaOps() {
	const store = etaStore();
	return {
		send: (message: ClientMessage) => store.send(message),
	};
}

/** Test-only: drop the module singleton so the next `etaStore()` reconnects. */
export function resetEtaStoreForTests(): void {
	instance?.dispose();
	instance = undefined;
}
