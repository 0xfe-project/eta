// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { byId, queryId } from "./dom.ts";
import { FakeSocket } from "./fake-socket.ts";
import { click, flush, render } from "./render.tsx";
import { Route } from "@solidjs/router";
import { MemoryRouter } from "./memory-router.tsx";
import { SessionsPage } from "../src/pages/sessions-page.tsx";
import { ThemeProvider } from "../src/app/theme.tsx";

function view(session: string, patch: Record<string, unknown> = {}): unknown {
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
		...patch,
	};
}

const userEntry = { entryId: "e1", seq: 1, at: 1, message: { role: "user", content: "hello", timestamp: 1 } };
const toolCallEntry = {
	entryId: "e2",
	seq: 2,
	at: 2,
	message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts" } }], timestamp: 2 },
};
const toolResultEntry = {
	entryId: "e3",
	seq: 3,
	at: 3,
	message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "FILE BODY" }], timestamp: 3 },
};

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

	it("right panel offers context / workspace / terminal / log and keeps the terminal alive", () => {
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
		expect(queryId("tab-context")).not.toBeNull();
		expect(queryId("tab-workspace")).not.toBeNull();
		expect(queryId("tab-terminal")).not.toBeNull();
		expect(queryId("tab-log")).not.toBeNull();
		click("tab-workspace");
		expect(queryId("workspace-panel")).not.toBeNull();
		click("tab-log");
		expect(queryId("log-rail")).not.toBeNull();
		click("tab-context");
		expect(queryId("workspace-panel")).toBeNull();
		// No terminal until it is asked for, then never unmounted again: a pty
		// that dies on tab switch would take `vim` with it.
		expect(queryId("panel-terminal")).toBeNull();
		click("tab-terminal");
		expect(byId("panel-terminal").getAttribute("data-active")).toBe("1");
		expect(byId("terminal-host").getAttribute("data-variant")).toBe("panel");
		click("tab-context");
		expect(byId("panel-terminal").getAttribute("data-active")).toBe("0");
	});

	it("pauses the log rail so later frames stay off the list", () => {
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
		click("tab-log");
		expect(document.querySelectorAll('[data-testid="log-frame"]')).toHaveLength(3);
		click("log-pause");
		expect(queryId("log-pause")?.textContent).toBe("resume");
		flush(() =>
			socket.fire("message", {
				data: JSON.stringify({ channel: "dev", frame: { ts: 99, session: "s1", category: "state", action: "paused-out", data: {} } }),
			}),
		);
		expect(document.querySelectorAll('[data-testid="log-frame"]')).toHaveLength(3);
		expect(document.body.textContent).not.toContain("paused-out");
		click("log-pause");
		expect(document.querySelectorAll('[data-testid="log-frame"]')).toHaveLength(4);
		expect(document.body.textContent).toContain("paused-out");
	});

	it("reuses transcript rows across view frames instead of rebuilding them", async () => {
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
		const frame = async (patch: Record<string, unknown>) => {
			flush(() => socket.fire("message", { data: JSON.stringify({ channel: "view", session: "s1", view: view("s1", patch) }) }));
			// Follow-scroll is throttled to one write per painted frame; let it paint.
			await new Promise((resolve) => requestAnimationFrame(resolve));
		};
		/** The `<For>` row element itself — the thing that must survive a frame. */
		const row = (entryId: string) => document.getElementById(`eta-msg-${entryId}`) as HTMLElement;

		await frame({ messages: [userEntry, toolCallEntry] });
		const userRow = row("e1");
		const badge = byId("tool-badge-c1");
		expect(badge.className).toContain("running");
		expect(queryId("streaming-row")).toBeNull();

		// jsdom lays nothing out, so watch the writes: a frame that grows the
		// transcript must still drive the follow-the-tail effect.
		let scrolls = 0;
		let scrollTop = 0;
		const scroller = byId("timeline");
		Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 1000 });
		Object.defineProperty(scroller, "scrollTop", {
			configurable: true,
			get: () => scrollTop,
			set: (next: number) => {
				scrollTop = next;
				scrolls += 1;
			},
		});

		await frame({ messages: [userEntry, toolCallEntry], streaming: { role: "assistant", content: "hel", timestamp: 2 } });
		expect(scrolls).toBe(1);
		const streamRow = byId("streaming-row");
		expect(row("e1")).toBe(userRow);
		const assistantRow = row("e2");
		expect(assistantRow).not.toBeNull();
		expect(byId("tool-badge-c1")).toBe(badge);

		await frame({ messages: [userEntry, toolCallEntry], streaming: { role: "assistant", content: "hello there", timestamp: 2 } });
		expect(scrolls).toBe(2);
		expect(row("e1")).toBe(userRow);
		expect(row("e2")).toBe(assistantRow);
		expect(byId("streaming-row")).toBe(streamRow);
		expect(document.body.textContent).toContain("hello there");

		// The result arrives as a new entry. The already-mounted tool card has to
		// notice it on its own — re-mounting the row is not available as a fix.
		await frame({ messages: [userEntry, toolCallEntry, toolResultEntry] });
		expect(scrolls).toBe(3);
		expect(row("e1")).toBe(userRow);
		expect(row("e2")).toBe(assistantRow);
		expect(byId("tool-badge-c1")).toBe(badge);
		expect(byId("tool-badge-c1").className).toContain("done");
		expect(document.body.textContent).toContain("FILE BODY");
	});
});
