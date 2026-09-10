// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryId } from "./dom.ts";
import { FakeSocket } from "./fake-socket.ts";
import { click, flush, render } from "./render.tsx";
import { Route } from "@solidjs/router";
import { MemoryRouter } from "./memory-router.tsx";
import { SessionsPage } from "../src/pages/sessions-page.tsx";
import { ThemeProvider } from "../src/app/theme.tsx";

function view(session: string): unknown {
	return {
		stateKeys: [],
		messages: [{ entryId: "e1", seq: 1, at: 1, message: { role: "user", content: "hello", timestamp: 1 } }],
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
		tools: [],
		personas: ["eta"],
		prompt: { stableChars: 4, adaptiveChars: 2, sections: [{ name: "base", stable: true, text: "BASE" }] },
		tokensPerSec: 0,
		running: false,
		kind: session,
	};
}

describe("sessions page smoke", () => {
	beforeEach(() => {
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal("fetch", () => Promise.resolve({ ok: false, json: () => Promise.resolve([]) } as Response));
	});

	it("renders a hello + view without looping", () => {
		render(
			<ThemeProvider>
				<MemoryRouter>
					<Route path="/" component={SessionsPage} />
				</MemoryRouter>
			</ThemeProvider>,
		);
		expect(queryId("welcome-wordmark")).not.toBeNull();
		const socket = FakeSocket.instances[0]!;
		flush(() => socket.fire("open", {}));
		flush(() => socket.fire("message", { data: JSON.stringify({ type: "hello", sessions: [{ name: "s1", badges: [], personas: [] }], attach: "s1" }) }));
		flush(() => socket.fire("message", { data: JSON.stringify({ channel: "view", session: "s1", view: view("s1") }) }));
		expect(queryId("user-message")).not.toBeNull();
		flush(() => click("prompt-open"));
		expect(queryId("prompt-section-base")).not.toBeNull();
	});

	it("pauses the dev rail so later frames stay off the list", () => {
		render(
			<ThemeProvider>
				<MemoryRouter>
					<Route path="/" component={SessionsPage} />
				</MemoryRouter>
			</ThemeProvider>,
		);
		const socket = FakeSocket.instances[0]!;
		flush(() => socket.fire("open", {}));
		flush(() => socket.fire("message", { data: JSON.stringify({ type: "hello", sessions: [{ name: "s1", badges: [], personas: [] }], attach: "s1" }) }));
		flush(() => socket.fire("message", { data: JSON.stringify({ channel: "view", session: "s1", view: view("s1") }) }));
		for (let i = 0; i < 3; i += 1) {
			flush(() =>
				socket.fire("message", {
					data: JSON.stringify({ channel: "dev", frame: { ts: i, session: "s1", category: "state", action: `a${i}`, data: {} } }),
				}),
			);
		}
		click("tab-dev");
		expect(document.querySelectorAll('[data-testid="dev-frame"]')).toHaveLength(3);
		click("dev-pause");
		expect(queryId("dev-pause")?.textContent).toBe("resume");
		flush(() =>
			socket.fire("message", {
				data: JSON.stringify({ channel: "dev", frame: { ts: 99, session: "s1", category: "state", action: "paused-out", data: {} } }),
			}),
		);
		expect(document.querySelectorAll('[data-testid="dev-frame"]')).toHaveLength(3);
		expect(document.body.textContent).not.toContain("paused-out");
		click("dev-pause");
		expect(document.querySelectorAll('[data-testid="dev-frame"]')).toHaveLength(4);
		expect(document.body.textContent).toContain("paused-out");
	});
});
