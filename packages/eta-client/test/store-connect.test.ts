// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EtaStore } from "../src/lib/eta-store.ts";

class MiniSocket {
	static instances: MiniSocket[] = [];
	readyState = 1;
	private readonly handlers = new Map<string, ((data?: unknown) => void)[]>();

	readonly url: string;

	constructor(url: string) {
		this.url = url;
		MiniSocket.instances.push(this);
	}

	addEventListener(type: string, handler: (data?: unknown) => void): void {
		this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
	}

	send(): void {}

	close(): void {
		this.readyState = 3;
		this.fire("close");
	}

	fire(type: string, data?: unknown): void {
		for (const handler of this.handlers.get(type) ?? []) handler(data);
	}

	fireMessage(payload: unknown): void {
		this.fire("message", { data: JSON.stringify(payload) });
	}
}

describe("eta store connection", () => {
	beforeEach(() => {
		MiniSocket.instances = [];
		vi.stubGlobal("WebSocket", MiniSocket);
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("reconnects with backoff after the socket closes", () => {
		const store = new EtaStore("ws://test/ws");
		store.connect();
		expect(MiniSocket.instances).toHaveLength(1);
		const first = MiniSocket.instances[0]!;
		first.fireMessage({ type: "hello", sessions: [{ name: "a", badges: [], personas: [] }], attach: "a" });
		expect(store.snapshot().connected).toBe(true);

		first.close();
		expect(store.snapshot().connected).toBe(false);
		vi.advanceTimersByTime(499);
		expect(MiniSocket.instances).toHaveLength(1);
		vi.advanceTimersByTime(2);
		expect(MiniSocket.instances).toHaveLength(2);

		const second = MiniSocket.instances[1]!;
		second.fireMessage({ type: "hello", sessions: [{ name: "b", badges: [], personas: [] }], attach: "b" });
		expect(store.snapshot().sessions.map((s) => s.name)).toEqual(["b"]);
	});
});
