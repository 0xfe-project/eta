import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { BtwManager, btwSideAsk } from "../../src/harness/btw.ts";
import { DEPTH_CAP, SubagentManager, type SubagentRecord, type SubagentBus } from "../../src/harness/subagent.ts";

describe("btw side channel", () => {
	const userMsg = { role: "user", content: [{ type: "text", text: "main" }], timestamp: 0 };
	const btwMsg = { role: "custom", customType: "eta.btw", content: [], timestamp: 0 };
	const entries = [userMsg, btwMsg];
	const SIDE_USAGE = {
		input: 5,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 7,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	} as const;

	it("contextual seed drops visible btw chatter", () => {
		const mgr = new BtwManager(() => ({ messages: [userMsg, btwMsg] as never[] }));
		const t = mgr.create("contextual");
		mgr.seedFrom(t.id, entries, "leaf");
		expect(mgr.messagesFor(t.id)).toEqual([userMsg]);
	});
	it("fallback path filters entries directly when context build fails", () => {
		const mgr = new BtwManager(() => {
			throw new Error("no leaf");
		});
		const t = mgr.create("contextual");
		mgr.seedFrom(t.id, entries, null);
		expect(mgr.messagesFor(t.id).length).toBe(1);
	});
	it("answered exchanges replay as plain pairs", () => {
		const mgr = new BtwManager(() => ({ messages: [] }));
		const t = mgr.create("tangent");
		mgr.answer(t.id, "which?", "b");
		const msgs = mgr.messagesFor(t.id) as {
			role: string;
			content: { type: string; text: string }[];
			stopReason?: string;
		}[];
		expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
		// The replayed answer is a real assistant message, not a bare string: provider
		// adapters read assistant content as blocks.
		expect(msgs[1]?.content[0]?.text).toBe("b");
		expect(msgs[1]?.stopReason).toBe("stop");
	});
	it("saving while the main run is busy queues, then flushes at the boundary", async () => {
		const notes: string[] = [];
		const mgr = new BtwManager(
			() => ({ messages: [] }),
			(n) => {
				notes.push(n);
			},
		);
		const t = mgr.create("tangent");
		mgr.answer(t.id, "q", "a");
		expect(mgr.save(t.id, true)).toBe("queued");
		expect(notes.length).toBe(0);
		expect(await mgr.flushQueued()).toBe(1);
		expect(mgr.get(t.id)?.saveState).toBe("saved");
		expect(notes.length).toBe(1);
	});
	it("a side question waits as pending, then becomes the answered exchange", async () => {
		const asked: { question: string; messages: unknown[] }[] = [];
		const mgr = new BtwManager(
			() => ({ messages: [] }),
			undefined,
			undefined,
			async (request) => {
				asked.push({ question: request.question, messages: request.messages });
				return { text: "4", usage: SIDE_USAGE };
			},
		);
		const t = mgr.create("tangent");
		const running = mgr.ask(t.id, "what is 2+2?");
		expect(mgr.get(t.id)?.pending?.question).toBe("what is 2+2?");
		expect(mgr.get(t.id)?.exchanges.length).toBe(0);
		await running;
		expect(mgr.get(t.id)?.pending).toBeUndefined();
		expect(mgr.get(t.id)?.exchanges.map((e) => [e.question, e.answer])).toEqual([["what is 2+2?", "4"]]);
		// The next question replays the answered pair, so the thread stays continuous
		// (the request itself carries the new question on top of it).
		await mgr.ask(t.id, "and 4+4?");
		const replayed = asked[1]?.messages as { role: string; content: { text?: string }[] }[];
		expect(replayed?.map((m) => [m.role, m.content[0]?.text])).toEqual([
			["user", "what is 2+2?"],
			["assistant", "4"],
		]);
	});
	it("a failed side request leaves no exchange behind, only an error", async () => {
		const mgr = new BtwManager(
			() => ({ messages: [] }),
			undefined,
			undefined,
			() => Promise.reject(new Error("provider down")),
		);
		const t = mgr.create("tangent");
		await mgr.ask(t.id, "q");
		expect(mgr.get(t.id)?.exchanges.length).toBe(0);
		expect(mgr.get(t.id)?.pending).toBeUndefined();
		expect(mgr.get(t.id)?.error).toBe("provider down");
	});
	it("override change rebuilds the child but keeps the thread", () => {
		const mgr = new BtwManager(() => ({ messages: [] }));
		const t = mgr.create("contextual");
		mgr.answer(t.id, "q", "a");
		const v = t.assemblyVersion;
		mgr.setOverride(t.id, { model: "other" });
		expect(mgr.get(t.id)?.assemblyVersion).toBe(v + 1);
		expect(mgr.get(t.id)?.exchanges.length).toBe(1);
	});
	it("replay restores threads from eta.btw entries", () => {
		const mgr = new BtwManager(() => ({ messages: [] }));
		mgr.replay([
			{
				type: "btw",
				payload: {
					id: "btw-9",
					kind: "tangent",
					note: "n",
					exchanges: [{ question: "q", answer: "a", at: 1 }],
					saveState: "saved",
				},
			},
		]);
		expect(mgr.get("btw-9")?.saveState).toBe("saved");
	});
	it("handoff hands the main run the thread itself, not a pointer to it", () => {
		const mgr = new BtwManager(() => ({ messages: [] }));
		const t = mgr.create("tangent");
		expect(mgr.handoff(t.id)).toBeUndefined();
		mgr.answer(t.id, "which editor?", "the one you already know");
		const text = mgr.handoff(t.id) ?? "";
		expect(text).toContain(`[btw ${t.id}]`);
		expect(text).toContain("Q: which editor?");
		expect(text).toContain("A: the one you already know");
	});
	it("an override cleared with null goes back to inheriting the session", () => {
		const mgr = new BtwManager(() => ({ messages: [] }));
		const t = mgr.create("contextual", { model: "anthropic:claude-haiku-4-5", thinking: "low" });
		const version = mgr.get(t.id)?.assemblyVersion ?? 0;
		mgr.setOverride(t.id, { model: null, thinking: null });
		expect(mgr.get(t.id)?.model).toBeUndefined();
		expect(mgr.get(t.id)?.thinking).toBeUndefined();
		expect(mgr.get(t.id)?.assemblyVersion).toBe(version + 1);
	});
	it("an override that changed nothing leaves the assembly alone", () => {
		const mgr = new BtwManager(() => ({ messages: [] }));
		const t = mgr.create("contextual", { model: "m" });
		const version = mgr.get(t.id)?.assemblyVersion ?? 0;
		mgr.setOverride(t.id, { model: "m" });
		expect(mgr.get(t.id)?.assemblyVersion).toBe(version);
	});
	it("a side answer's usage is handed to the session ledger", async () => {
		const recorded: { threadId: string; output: number }[] = [];
		const ask = btwSideAsk({
			models: {
				getModels: () => [],
				getModel: () => undefined,
				completeSimple: async () =>
					({
						role: "assistant",
						content: [{ type: "text", text: "4" }],
						usage: SIDE_USAGE,
						stopReason: "stop",
					}) as never,
			} as never,
			currentModel: async () => ({ id: "fake" }) as never,
			context: BACKGROUND_CONTEXT,
			onUsage: (usage, threadId) => recorded.push({ threadId, output: usage.output }),
		});
		const answer = await ask({ threadId: "btw-1", kind: "tangent", question: "q", messages: [] });
		expect(answer.text).toBe("4");
		expect(recorded).toEqual([{ threadId: "btw-1", output: 2 }]);
	});
});

function bus() {
	const events: string[] = [];
	const b: SubagentBus = { emit: (t, p) => events.push(`${t}:${p.id}`) };
	return { b, events };
}

describe("subagent manager", () => {
	const deferred = () => {
		let resolve!: (u: { input: number; output: number }) => void;
		const promise = new Promise<{ input: number; output: number }>((r) => (resolve = r));
		return { promise, resolve };
	};

	it("caps the background pool at the configured size", () => {
		const { b } = bus();
		const handles: ReturnType<typeof deferred>[] = [];
		const mgr = new SubagentManager(
			b,
			() => {
				const d = deferred();
				handles.push(d);
				return d.promise;
			},
			2,
		);
		mgr.spawn({ prompt: "a" });
		mgr.spawn({ prompt: "b" });
		const third = mgr.spawn({ prompt: "c" });
		expect(mgr.list().filter((r) => r.status === "running").length).toBe(2);
		expect(third.status).toBe("queued");
		mgr.settle("sub-1", { input: 1, output: 1 });
		expect(mgr.get(third.id)?.status).toBe("running");
	});
	it("nested children bypass the queue (no parent deadlock)", () => {
		const { b } = bus();
		const mgr = new SubagentManager(b, () => new Promise(() => {}), 1);
		const parent = mgr.spawn({ prompt: "p" });
		mgr.spawn({ prompt: "fills" });
		const child = mgr.spawn({ prompt: "child" }, parent.id);
		expect(child.status).toBe("running");
	});
	it("foreground waits use a separate lane", () => {
		const { b } = bus();
		const mgr = new SubagentManager(b, () => new Promise(() => {}), 1);
		mgr.spawn({ prompt: "bg" });
		const fg = mgr.spawnAndWait({ prompt: "fg" });
		expect(fg.status).toBe("running");
	});
	it("depth cap: " + DEPTH_CAP, () => {
		const { b } = bus();
		const mgr = new SubagentManager(b, () => new Promise(() => {}));
		const a = mgr.spawn({ prompt: "a" });
		const c = mgr.spawn({ prompt: "c" }, a.id);
		expect(() => mgr.spawn({ prompt: "d" }, c.id)).toThrow(/depth cap/);
	});
	it("ownership: only the parent may stop a child", () => {
		const { b } = bus();
		const mgr = new SubagentManager(b, () => new Promise(() => {}));
		const a = mgr.spawn({ prompt: "a" });
		const sibs = mgr.spawn({ prompt: "s" });
		const child = mgr.spawn({ prompt: "child" }, a.id);
		expect(() => mgr.stop(child.id, sibs.id)).toThrow(/not your child/);
	});
	it("a parent reaching a terminal state stops its descendants", () => {
		const { b } = bus();
		const mgr = new SubagentManager(b, () => new Promise(() => {}));
		const p = mgr.spawn({ prompt: "p" });
		const g = mgr.spawn({ prompt: "g" }, p.id);
		mgr.settle(p.id, { input: 2, output: 1 });
		expect(mgr.get(g.id)?.status).toBe("stopped");
	});
	it("usage rolls up through the chain", async () => {
		const { b } = bus();
		let childDone!: (u: { input: number; output: number }) => void;
		const childP = new Promise<{ input: number; output: number }>((r) => (childDone = r));
		const mgr = new SubagentManager(b, (r: SubagentRecord) =>
			r.spec.prompt === "child" ? childP : childP.then(() => ({ input: 1, output: 1 })),
		);
		const p = mgr.spawn({ prompt: "parent" });
		const c = mgr.spawn({ prompt: "child" }, p.id);
		childDone({ input: 5, output: 2 });
		await new Promise((r) => setTimeout(r, 0));
		expect(mgr.get(c.id)?.status).toBe("done");
		expect(mgr.get(p.id)?.totalUsage).toEqual({ input: 6, output: 3 });
	});
	it("turn limit: warning then hard stop", async () => {
		const { b, events } = bus();
		let api!: { reportTurn(id: string): void };
		const mgr = new SubagentManager(b, (_r, a) => {
			api = a;
			return new Promise(() => {});
		});
		const r = mgr.spawn({ prompt: "runaway", maxTurns: 3 });
		api.reportTurn(r.id);
		expect(mgr.get(r.id)?.warnedWrapUp).toBe(false);
		api.reportTurn(r.id);
		expect(mgr.get(r.id)?.warnedWrapUp).toBe(true);
		api.reportTurn(r.id);
		expect(mgr.get(r.id)?.status).toBe("failed");
		expect(events).toContain(`subagents:failed:${r.id}`);
	});
});
