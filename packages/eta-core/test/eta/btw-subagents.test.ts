import { describe, expect, it } from "vitest";
import { BtwManager } from "../../src/harness/btw.ts";
import { DEPTH_CAP, SubagentManager, type SubagentRecord, type SubagentBus } from "../../src/harness/subagent.ts";

describe("btw side channel", () => {
	const userMsg = { role: "user", content: [{ type: "text", text: "main" }], timestamp: 0 };
	const btwMsg = { role: "custom", customType: "eta.btw", content: [], timestamp: 0 };
	const entries = [userMsg, btwMsg];

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
		const msgs = mgr.messagesFor(t.id) as { role: string; content: string }[];
		expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(msgs[1].content).toBe("b");
	});
	it("saving while the main run is busy queues, then flushes at the boundary", async () => {
		const notes: string[] = [];
		const mgr = new BtwManager(() => ({ messages: [] }), (n) => { notes.push(n); });
		const t = mgr.create("tangent");
		mgr.answer(t.id, "q", "a");
		expect(mgr.save(t.id, true)).toBe("queued");
		expect(notes.length).toBe(0);
		expect(await mgr.flushQueued()).toBe(1);
		expect(mgr.get(t.id)?.saveState).toBe("saved");
		expect(notes.length).toBe(1);
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
		mgr.replay([{ type: "btw", payload: { id: "btw-9", kind: "tangent", note: "n", exchanges: [{ question: "q", answer: "a", at: 1 }], saveState: "saved" } }]);
		expect(mgr.get("btw-9")?.saveState).toBe("saved");
	});
	it("handoff hands a followUp for threads with results", () => {
		const mgr = new BtwManager(() => ({ messages: [] }));
		const t = mgr.create("tangent");
		expect(mgr.handoff(t.id)).toBeUndefined();
		mgr.answer(t.id, "q", "a");
		expect(mgr.handoff(t.id)).toContain("side thread has results");
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
		const mgr = new SubagentManager(b, () => {
			const d = deferred();
			handles.push(d);
			return d.promise;
		}, 2);
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
		const mgr = new SubagentManager(b, (r: SubagentRecord) => (r.spec.prompt === "child" ? childP : childP.then(() => ({ input: 1, output: 1 }))));
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
