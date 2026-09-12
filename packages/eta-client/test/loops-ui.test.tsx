// @vitest-environment jsdom
/**
 * The loop controls, split the way the state machine is: the strip above the composer
 * says that something is scheduled and points at the panel, and the panel is where a
 * loop is created — and it will not send one that has nothing to trigger it, because a
 * loop with no cadence can never fire and would sit in the list looking scheduled.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "@eta/core";
import { byId } from "./dom.ts";
import { FakeSocket } from "./fake-socket.ts";
import { click, render } from "./render.tsx";
import { setField } from "./render.tsx";

function view(patch: Record<string, unknown> = {}): SessionView {
	return {
		stateKeys: [],
		messages: [],
		systems: [],
		thinking: [],
		compactionEpoch: 0,
		subagents: [],
		queue: [],
		goal: undefined,
		tasks: [],
		sideThread: [],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 },
		cacheRate: 0,
		branch: { tipId: null },
		pendingAsk: undefined,
		tools: [],
		personas: [],
		prompt: undefined,
		memory: undefined,
		tokensPerSec: 0,
		loops: [],
		...patch,
	} as unknown as SessionView;
}

const LOOP = { id: "l1", note: "check the build", every: "5m", runCount: 2, paused: false, nextDueAt: Date.now() + 60_000 };
const PAUSED = { id: "l2", note: "tick", every: "1h", runCount: 0, paused: true };

describe("the loop form", () => {
	beforeEach(() => {
		vi.stubGlobal("WebSocket", FakeSocket);
		FakeSocket.reset();
	});

	it("holds the click until an interval is given, then sends it", async () => {
		const { ContextPanel } = await import("../src/features/sessions/context-panel.tsx");
		render(<ContextPanel session="s1" view={view()} />);
		setField("loop-note", "check the build");
		expect((byId("loop-add") as HTMLButtonElement).disabled).toBe(true);
		setField("loop-every", "5m");
		expect((byId("loop-add") as HTMLButtonElement).disabled).toBe(false);
		click("loop-add");
		expect(FakeSocket.last()).toMatchObject({ op: "loopCreate", session: "s1", note: "check the build", every: "5m" });
	});

	it("shows what each loop is scheduled on", async () => {
		const { ContextPanel } = await import("../src/features/sessions/context-panel.tsx");
		render(<ContextPanel session="s1" view={view({ loops: [LOOP] })} />);
		expect(byId("loop-row-l1").textContent).toContain("5m");
	});
});

describe("the strip above the composer", () => {
	beforeEach(() => {
		vi.stubGlobal("WebSocket", FakeSocket);
		FakeSocket.reset();
	});

	it("counts the loops instead of repeating the panel's rows", async () => {
		const { ContextBar } = await import("../src/features/sessions/context-bar.tsx");
		render(<ContextBar session="s1" view={view({ loops: [LOOP, PAUSED] })} />);
		// One of two running, and no per-loop row: pausing belongs to the panel.
		expect(byId("loops-summary").textContent).toContain("1/2");
		expect(document.querySelector('[data-testid="loop-row-l1"]')).toBeNull();
	});

	it("points the click at the panel that manages them", async () => {
		const { ContextBar } = await import("../src/features/sessions/context-bar.tsx");
		render(<ContextBar session="s1" view={view({ loops: [LOOP] })} />);
		let shown = 0;
		window.addEventListener("eta:show-loops", () => {
			shown += 1;
		});
		click("loops-summary");
		expect(shown).toBe(1);
	});
});
