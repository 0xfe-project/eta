import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { render, act } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import { MemoryRouter } from "./memory-router.tsx";
import { SessionsPage } from "../src/pages/sessions-page.tsx";
import { ThemeProvider } from "../src/app/theme.tsx";
import { etaStore } from "../src/lib/eta-store.ts";
import { ThemeProvider as _tp } from "../src/app/theme.tsx";

void _tp;

class FakeSocket {
	static instances: FakeSocket[] = [];
	readyState = 1;
	listeners = new Map<string, ((event: unknown) => void)[]>();
	constructor(_url: string) {
		FakeSocket.instances.push(this);
	}
	addEventListener(type: string, cb: (event: unknown) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
	}
	send(_data: string): void {}
	close(): void {}
	fire(type: string, event: unknown): void {
		for (const cb of this.listeners.get(type) ?? []) cb(event);
	}
}

function view(session: string): unknown {
	return {
		stateKeys: [],
		messages: [{ entryId: "e1", seq: 1, message: { role: "user", content: "hello", timestamp: 1 } }],
		systems: [],
		thinking: [],
		compactionEpoch: 0,
		subagents: [],
		goal: undefined,
		tasks: [],
		loops: [],
		sideThread: [],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 },
		cacheRate: 0,
		branch: { tipId: "e1" },
		pendingAsk: undefined,
		personas: ["eta"],
		prompt: { stableChars: 4, adaptiveChars: 2, sections: [{ name: "base", stable: true, text: "BASE" }] },
		tokensPerSec: 0,
		running: false,
		kind: session,
	};
}

afterEach(() => {
	cleanup();
	FakeSocket.instances = [];
	vi.unstubAllGlobals();
});

describe("sessions page smoke", () => {
	it("renders a hello + view without looping", () => {
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal("fetch", () => Promise.resolve({ ok: false, json: () => Promise.resolve([]) } as Response));
		render(
			<StrictMode>
				<ThemeProvider>
					<MemoryRouter>
						<SessionsPage />
					</MemoryRouter>
				</ThemeProvider>
			</StrictMode>,
		);
		expect(document.querySelector("[data-testid='welcome-wordmark']")).not.toBeNull();
		const socket = FakeSocket.instances[0]!;
		act(() => socket.fire("open", {}));
		act(() => socket.fire("message", { data: JSON.stringify({ type: "hello", sessions: [{ name: "s1", badges: [], personas: [] }], attach: "s1" }) }));
		act(() => socket.fire("message", { data: JSON.stringify({ channel: "view", session: "s1", view: view("s1") }) }));
		if (document.querySelector("[data-testid='user-message']") === null) console.log("BODY:", document.body.innerHTML.slice(0, 1200));
		expect(document.querySelector("[data-testid='user-message']")).not.toBeNull();
		act(() => {
			(document.querySelector("[data-testid='prompt-open']") as HTMLButtonElement).click();
		});
		expect(document.querySelector("[data-testid='prompt-section-base']")).not.toBeNull();
	});
});

void etaStore;
