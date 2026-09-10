// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "@solidjs/router";
import { byId, queryId } from "./dom.ts";
import { click, flush, render } from "./render.tsx";
import { FakeSocket } from "./fake-socket.ts";
import { MemoryRouter } from "./memory-router.tsx";
import { ThemeProvider } from "../src/app/theme.tsx";
import { SessionsPage } from "../src/pages/sessions-page.tsx";
import { useEta, useEtaOps } from "../src/lib/eta-store.ts";

function session(name: string): unknown {
	return { name, badges: [], personas: ["Thinker"], cwd: "/w" };
}

/** The smallest thing that still counts as a transcript: one user message. */
function view(text: string): unknown {
	return {
		stateKeys: [],
		messages: [{ entryId: `e-${text}`, seq: 1, at: 1, message: { role: "user", content: text, timestamp: 1 } }],
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
		branch: { tipId: `e-${text}` },
		pendingAsk: undefined,
		tools: [],
		personas: ["Thinker"],
		prompt: { stableChars: 4, adaptiveChars: 2, sections: [] },
		tokensPerSec: 0,
	};
}

/** Reads the mirror directly: which sessions exist as store state. */
function Probe(props: { focus: string }) {
	const state = useEta();
	const { send } = useEtaOps();
	return (
		<div>
			<span data-testid="mirrored">{Object.keys(state.views).sort().join(",")}</span>
			<button data-testid={`focus-${props.focus}`} onClick={() => send({ op: "focus", session: props.focus })}>
				focus
			</button>
		</div>
	);
}

function mount() {
	render(
		<ThemeProvider>
			<MemoryRouter>
				<Route path="/" component={() => (<><SessionsPage /><Probe focus="b" /></>)} />
			</MemoryRouter>
		</ThemeProvider>,
	);
	const socket = FakeSocket.instances[0]!;
	flush(() => socket.fire("open", {}));
	const send = (payload: unknown) => flush(() => socket.fire("message", { data: JSON.stringify(payload) }));
	send({ type: "hello", sessions: [session("a"), session("b")], attach: "a" });
	return { send };
}

describe("view mirror is only the session in front", () => {
	beforeEach(() => {
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal("fetch", () => Promise.resolve({ ok: false, json: () => Promise.resolve([]) } as Response));
	});

	it("reconciles the attached session and buffers the others", () => {
		const { send } = mount();
		send({ channel: "view", session: "a", view: view("FG") });
		send({ channel: "view", session: "b", view: view("BG") });
		expect(byId("mirrored").textContent).toBe("a");
		expect(queryId("user-message")).not.toBeNull();

		// Frames for the session behind still arrive — they just cost a map write
		// instead of a walk over the whole transcript.
		send({ channel: "view", session: "b", view: view("BG2") });
		expect(byId("mirrored").textContent).toBe("a");
	});

	it("brings the buffered frame in when the session comes to the front", () => {
		const { send } = mount();
		send({ channel: "view", session: "a", view: view("FG") });
		send({ channel: "view", session: "b", view: view("BG") });
		expect(byId("user-message").textContent).toContain("FG");
		flush(() => click("focus-b"));
		expect(byId("mirrored").textContent).toBe("a,b");
		// No extra round trip: the frame that arrived while b was in the background
		// is what paints, the moment b is in front.
		expect(byId("user-message").textContent).toContain("BG");
		expect(FakeSocket.last()).toEqual({ op: "focus", session: "b" });

		// And from here it is b that gets reconciled, a that gets buffered.
		send({ channel: "view", session: "a", view: view("FG2") });
		expect(byId("user-message").textContent).toContain("BG");
	});

	it("clears every mirror on a reconnect, stale buffers included", () => {
		const { send } = mount();
		send({ channel: "view", session: "a", view: view("FG") });
		send({ channel: "view", session: "b", view: view("BG") });
		send({ type: "hello", sessions: [session("a")], attach: "a" });
		expect(byId("mirrored").textContent).toBe("");
		send({ channel: "view", session: "a", view: view("FG") });
		expect(byId("mirrored").textContent).toBe("a");
	});
});
