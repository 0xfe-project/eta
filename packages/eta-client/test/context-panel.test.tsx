// @vitest-environment jsdom
/**
 * The top of the context panel: the two claims a session is judged by.
 *
 * The panel used to report a folder and a token split and call it context. What it could
 * not answer was the question that actually gets asked after a weird answer — *which model
 * replied, and where did the sentence about "use bun" come from*? Both rows here are the
 * harness's own facts, not the composer's guess, and memory names files rather than
 * reassuringly saying "1 note": a note is only worth what its path is worth.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "@eta/core";
import { byId } from "./dom.ts";
import { FakeSocket } from "./fake-socket.ts";
import { render } from "./render.tsx";

function view(patch: Record<string, unknown> = {}): SessionView {
	return {
		stateKeys: [],
		messages: [],
		systems: [],
		thinking: [],
		compactionEpoch: 2,
		subagents: [],
		queue: [],
		goal: undefined,
		tasks: [],
		sideThread: [],
		usage: { input: 5_000, output: 1_200, cacheRead: 38_000, cacheWrite: 800, totalTokens: 45_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		cacheRate: 0.7,
		branch: { tipId: null },
		pendingAsk: undefined,
		tools: [],
		personas: [],
		prompt: undefined,
		memory: { chars: 128 },
		tokensPerSec: 0,
		loops: [],
		model: "pro6000:exo-lab/exo-6.5",
		cwd: "/Users/me/code/eta-agent",
		...patch,
	} as unknown as SessionView;
}

async function mount(patch: Record<string, unknown> = {}) {
	const { ContextPanel } = await import("../src/features/sessions/context-panel.tsx");
	render(<ContextPanel session="s1" view={view(patch)} />);
	// Two effects (models catalog, memory files) settle on microtasks; the rows they fill
	// must be there before the assertions read them.
	await new Promise((resolve) => setTimeout(resolve, 0));
}

const memoryBody = {
	text: "## decision\n- [0] use bun",
	files: ["/Users/me/code/eta-agent/.eta/MEMORY.md"],
	target: { path: "/Users/me/code/eta-agent/.eta/MEMORY.md", label: "eta-agent~9f3c" },
	projectRoot: "/Users/me/code/eta-agent",
};

describe("the panel's top rows", () => {
	beforeEach(() => {
		vi.stubGlobal("WebSocket", FakeSocket);
		FakeSocket.reset();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => ({
				ok: true,
				status: 200,
				json: async () =>
					url.includes("/api/memory")
						? memoryBody
						: url.includes("/api/models")
							? { models: [{ id: "exo-lab/exo-6.5", label: "Exo 6.5" }], current: "exo-lab/exo-6.5" }
							: [],
			})),
		);
	});

	it("names the model the harness is actually running, above the usage", async () => {
		await mount();
		expect(byId("panel-model").textContent).toBe("pro6000:exo-lab/exo-6.5");
		// The folder is not repeated here: the header above the transcript already shows it.
		expect(byId("section-model").textContent).not.toContain("/Users/me/code");
	});

	it("says which note files this session read, by path", async () => {
		await mount();
		expect(byId("memory-file").textContent).toBe("/Users/me/code/eta-agent/.eta/MEMORY.md");
	});

	it("names where the first note will go when the folder has none yet", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => ({
				ok: true,
				status: 200,
				json: async () =>
					url.includes("/api/memory")
						? { text: "", files: [], target: { path: "/work/notes/.eta/MEMORY.md" }, projectRoot: "/work/notes" }
						: { models: [], current: "exo-lab/exo-6.5" },
			})),
		);
		await mount({ memory: undefined });
		expect(byId("memory-none").textContent).toContain("/work/notes/.eta/MEMORY.md");
	});

	it("totals the whole session, not the slice still on screen", async () => {
		await mount();
		// 45,000 counted by the provider — well past the in/out pair the donut row lists.
		expect(byId("usage-total").textContent).toContain("45,000");
		expect(byId("usage-row").textContent).toContain("in 5,000");
		expect(byId("usage-row").textContent).toContain("cache read 38,000");
	});

	it("falls back to summing the parts when a provider never reported a total", async () => {
		await mount({ usage: { input: 100, output: 40, cacheRead: 10, cacheWrite: 0 } });
		expect(byId("usage-total").textContent).toContain("150");
	});

	it("shows the model that was asked for but is not running", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => ({
				ok: true,
				status: 200,
				json: async () =>
					url.includes("/api/memory")
						? memoryBody
						: { models: [{ id: "deepseek-v4", label: "DeepSeek V4" }], current: "deepseek-v4" },
			})),
		);
		await mount({ model: "pro6000:exo-lab/exo-6.5" });
		// The host was told to run deepseek; the harness is still on exo. The panel says so
		// instead of claiming the swap happened.
		expect(byId("panel-model").textContent).toBe("pro6000:exo-lab/exo-6.5");
		expect(byId("panel-model-pending").textContent).toContain("deepseek-v4");
	});
});
