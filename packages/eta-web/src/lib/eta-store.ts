/**
 * The single connection: one WebSocket, one store. Reconnects with backoff;
 * the server's hello + per-session view frames are the whole resync path, so
 * view state is fully replaced on (re)connect. UI reads via useSyncExternalStore.
 */

import { useSyncExternalStore } from "react";
import type { SessionView } from "@eta/core";
import type { ClientMessage, DevFrame, ServerMessage, SidebarSession } from "./protocol.ts";

const DEV_CAP = 512;

export interface EtaState {
	connected: boolean;
	sessions: SidebarSession[];
	attach: string | null;
	views: Record<string, SessionView>;
	dev: Record<string, DevFrame[]>;
	error: string | null;
}

export const initialEtaState: EtaState = { connected: false, sessions: [], attach: null, views: {}, dev: {}, error: null };

/** Pure reducer, exported for tests: fold one server frame into the state. */
export function reduceEtaState(state: EtaState, message: ServerMessage): EtaState {
	if ("channel" in message) {
		if (message.channel === "view") return { ...state, views: { ...state.views, [message.session]: message.view } };
		if (message.channel === "dev") {
			const existing = state.dev[message.frame.session] ?? [];
			return { ...state, dev: { ...state.dev, [message.frame.session]: [...existing, message.frame].slice(-DEV_CAP) } };
		}
		return state;
	}
	switch (message.type) {
		case "hello":
			return { ...state, connected: true, sessions: message.sessions, attach: state.sessions.length > 0 ? state.attach : message.attach, views: {}, dev: {}, error: null };
		case "sessions":
			return { ...state, sessions: message.sessions };
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
			this.state = reduceEtaState(this.state, JSON.parse(String(event.data)) as ServerMessage);
			this.emit();
		});
	}

	send(message: ClientMessage): void {
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
	return useSyncExternalStore(
		(listener) => store.subscribe(listener),
		() => store.snapshot(),
	);
}

export function useEtaOps() {
	const store = etaStore();
	return {
		send: (message: ClientMessage) => store.send(message),
	};
}
