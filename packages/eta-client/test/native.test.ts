// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EtaStore, initialEtaState, reduceEtaState } from "../src/lib/eta-store.ts";
import { NativeActions, emitNative, onNativeActions } from "../src/lib/native.ts";
import type { ServerMessage } from "@eta/core";

class MiniSocket {
	static instances: MiniSocket[] = [];
	readyState = 1;
	private readonly handlers = new Map<string, ((data?: unknown) => void)[]>();

	constructor(_url: string) {
		MiniSocket.instances.push(this);
	}

	addEventListener(type: string, handler: (data?: unknown) => void): void {
		this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
	}

	send(): void {}

	close(): void {
		this.readyState = 3;
	}

	fire(type: string, data?: unknown): void {
		for (const handler of this.handlers.get(type) ?? []) handler(data);
	}

	fireMessage(payload: unknown): void {
		this.fire("message", { data: JSON.stringify(payload) });
	}
}

describe("native shell commands", () => {
	beforeEach(() => {
		MiniSocket.instances = [];
		vi.stubGlobal("WebSocket", MiniSocket);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("turns a native frame into one window event and no state change", () => {
		const seen: unknown[] = [];
		const onEvent = (event: Event) => seen.push((event as CustomEvent).detail);
		window.addEventListener("eta:native", onEvent);

		const store = new EtaStore("ws://test/ws");
		store.connect();
		const before = store.snapshot();
		MiniSocket.instances[0]!.fireMessage({ type: "native", kind: "menu", action: NativeActions.toggleSidebar });
		store.dispose();

		window.removeEventListener("eta:native", onEvent);
		expect(seen).toEqual([{ kind: "menu", action: "view.toggle-sidebar", data: undefined }]);
		expect(store.snapshot()).toEqual(before);
	});

	it("leaves the folded state untouched, so an older client ignores it", () => {
		const frame = { type: "native", kind: "tray", action: "tray.focus-session", data: { session: "s" } } as ServerMessage;
		expect(reduceEtaState(initialEtaState, frame)).toBe(initialEtaState);
	});

	it("dispatches to the handler named by the action", () => {
		const toggled = vi.fn();
		const other = vi.fn();
		const detach = onNativeActions({ [NativeActions.toggleSidebar]: toggled, [NativeActions.abort]: other });
		emitNative({ kind: "menu", action: NativeActions.toggleSidebar });
		emitNative({ kind: "menu", action: "nobody.handle.me" });
		detach();
		emitNative({ kind: "menu", action: NativeActions.toggleSidebar });
		expect(toggled).toHaveBeenCalledTimes(1);
		expect(other).not.toHaveBeenCalled();
	});
});
