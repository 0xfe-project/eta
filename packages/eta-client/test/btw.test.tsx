// @vitest-environment jsdom
/**
 * The side thread, from the two ends that matter to the user: `/btw` opens it, and
 * what it shows is the session it belongs to — the model, the thinking level and the
 * tool list, read from the view rather than configured a second time. A thread holds
 * notes, and it can ask: a question goes to a side request on the session's own model,
 * which is why the thread carries an in-flight question and a failed one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "@eta/core";
import { byId } from "./dom.ts";
import { FakeSocket } from "./fake-socket.ts";
import { keyDown, render, setField } from "./render.tsx";

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
		sideThread: [{ id: "btw-1", kind: "contextual", exchanges: [], saveState: "not-saved" }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		cacheRate: 0,
		branch: { tipId: null },
		pendingAsk: undefined,
		tools: [
			{ name: "read", description: "Read a file" },
			{ name: "bash", description: "Run a command" },
		],
		personas: [],
		prompt: undefined,
		tokensPerSec: 0,
		loops: [],
		model: "pro6000:exo-lab/exo-6.5",
		thinkingLevel: "low",
		cwd: "/Users/me/code/eta-agent",
		...patch,
	} as unknown as SessionView;
}

describe("btw from the composer", () => {
	beforeEach(() => {
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => [] })));
	});

	it("/btw raises the dialog and sends no prompt", async () => {
		const { Composer } = await import("../src/features/sessions/composer.tsx");
		const opened: number[] = [];
		render(<Composer session="s1" running={false} hasPendingAsk={false} onBtw={() => opened.push(1)} />);
		setField("composer-input", "/btw");
		keyDown("composer-input", "Enter");
		expect(opened).toEqual([1]);
		expect(
			FakeSocket.sent
				.map((frame) => JSON.parse(String(frame)) as { op?: string })
				.filter((frame) => frame.op === "prompt"),
		).toEqual([]);
	});
});

describe("the side thread dialog", () => {
	beforeEach(() => {
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => [] })));
	});

	async function mount(current: boolean, threadPatch: Record<string, unknown> = {}) {
		const { BtwDialog } = await import("../src/features/sessions/btw-dialog.tsx");
		FakeSocket.reset();
		render(
			<BtwDialog
				session="s1"
				view={
					view({
						sideThread: current
							? [{ id: "btw-1", kind: "contextual", exchanges: [], saveState: "not-saved", ...threadPatch }]
							: [],
					})
				}
				open
				onOpenChange={() => undefined}
			/>,
		);
		return FakeSocket.sent.slice();
	}

	it("opening a thread with none in it asks for one", async () => {
		const sent = (await mount(false)).map((frame) => JSON.parse(String(frame)));
		expect(sent).toContainEqual({ op: "btwOpen", session: "s1", kind: "contextual" });
	});

	it("shows the session's own tools, not a second list", async () => {
		await mount(true);
		expect(byId("btw-tools").textContent).toContain("read");
		expect(byId("btw-tools").textContent).toContain("bash");
		expect(byId("btw-inherited").textContent).toContain("pro6000:exo-lab/exo-6.5");
	});

	it("Enter asks the thread, on the session's own model", async () => {
		await mount(true);
		FakeSocket.reset();
		setField("btw-input", "ping the vendor");
		keyDown("btw-input", "Enter");
		expect(FakeSocket.last()).toMatchObject({
			op: "btwAsk",
			session: "s1",
			threadId: "btw-1",
			question: "ping the vendor",
		});
	});

	it("records a note without asking, on the second button", async () => {
		await mount(true);
		FakeSocket.reset();
		setField("btw-input", "the vendor key rotated at 3am");
		(byId("btw-record") as HTMLButtonElement).click();
		expect(FakeSocket.last()).toMatchObject({
			op: "btwAnswer",
			session: "s1",
			threadId: "btw-1",
			question: "the vendor key rotated at 3am",
		});
	});

	// A side request takes seconds, so the thread carries the wait and the failure
	// instead of the panel going quiet.
	it("shows an in-flight question and refuses a second one", async () => {
		await mount(
			true,
			{ pending: { question: "ping the vendor", at: 1 } },
		);
		expect(byId("btw-pending").textContent).toContain("ping the vendor");
		expect((byId("btw-ask") as HTMLButtonElement).disabled).toBe(true);
	});

	it("shows what a side answer did to get there", async () => {
		await mount(true, {
			exchanges: [
				{
					question: "how big is the journal",
					answer: "545MB",
					at: 1,
					steps: [
						{ tool: "read", ok: true, at: 1 },
						{ tool: "bash", ok: false, at: 2 },
					],
				},
			],
		});
		expect(byId("btw-steps-0").textContent).toContain("read");
		expect(byId("btw-steps-0").textContent).toContain("bash×");
	});

	it("shows a failed request instead of an empty thread", async () => {
		await mount(true, { error: "provider exploded" });
		expect(byId("btw-error").textContent).toContain("provider exploded");
	});
});
