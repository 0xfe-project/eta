import { describe, expect, it } from "vitest";
import { AskRegistry, askResponseText, createAskUserTool } from "../../src/harness/ask.ts";
import { permissionGate } from "../../src/harness/permission.ts";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";

describe("ask registry", () => {
	it("holds a question until a human answers it", async () => {
		const reg = new AskRegistry();
		const p = reg.ask({ questionId: "q1", question: "which?" });
		expect(reg.pendingAsks().map((a) => a.questionId)).toEqual(["q1"]);
		expect(reg.answer("q1", { kind: "selection", selections: ["a"], comment: "but fast" })).toBe(true);
		expect(await p).toEqual({ kind: "selection", selections: ["a"], comment: "but fast" });
		expect(reg.answer("q1", { kind: "none" })).toBe(false);
		expect(askResponseText(await p)).toBe("Selected: a — but fast");
	});

	it("timeout and abort resolve to none", async () => {
		const reg = new AskRegistry();
		const to = await reg.ask({ questionId: "t", question: "?" }, { timeoutMs: 5 });
		expect(to).toEqual({ kind: "none" });
		const ac = new AbortController();
		const p = reg.ask({ questionId: "a", question: "?" }, { signal: ac.signal });
		ac.abort();
		expect(await p).toEqual({ kind: "none" });
	});

	it("replay re-surfaces unanswered asks from an entry log", () => {
		const reg = new AskRegistry();
		reg.replay([
			{ customType: "eta.ask", payload: { questionId: "q1", question: "still open" } },
			{ customType: "eta.ask", payload: { questionId: "q2", question: "answered" } },
			{ customType: "eta.answer", payload: { questionId: "q2", answers: ["x"] } },
		]);
		expect(reg.pendingAsks().map((a) => a.questionId)).toEqual(["q1"]);
	});
});

describe("ask_user tool", () => {
	it("waits after emitting the ask entry and renders the answer", async () => {
		const reg = new AskRegistry();
		const seen: string[] = [];
		const tool = createAskUserTool({ registry: reg, onAsk: (p) => { seen.push(p.questionId); } });
		const execution = tool.execute(
			"tc",
			{ question: "pick one", options: [{ title: "a" }, { title: "b" }] },
			() => {},
			{},
			{ invocationId: "inv-1", operationId: "op", turnId: "t", getMemo: async () => undefined, setMemo: async () => {} },
			BACKGROUND_CONTEXT,
		);
		await new Promise((r) => setTimeout(r, 0));
		expect(seen).toEqual(["inv-1"]);
		reg.answer("inv-1", { kind: "freeform", text: "b please" });
		const result = await execution;
		expect(result.content).toEqual([{ type: "text", text: "b please" }]);
		expect(result.details).toEqual({ kind: "freeform", text: "b please" });
	});
});

describe("permission gate", () => {
	const ev = { toolName: "bash", args: { cmd: "rm -rf" } };
	it("lets ungated tools through", async () => {
		const gate = permissionGate({ requiresApproval: () => false, approve: async () => false });
		expect(await gate(ev)).toBeUndefined();
	});
	it("denies on veto, throw, and silence (fail-closed)", async () => {
		const veto = permissionGate({ requiresApproval: () => true, approve: async () => false });
		expect(await veto(ev)).toEqual({ block: { reason: "permission denied" } });
		const boom = permissionGate({ requiresApproval: () => true, approve: () => Promise.reject(new Error("ui died")) });
		expect(await boom(ev)).toEqual({ block: { reason: "permission denied" } });
		const silent = permissionGate({ requiresApproval: () => true, approve: () => new Promise(() => {}), timeoutMs: 5 });
		expect(await silent(ev)).toEqual({ block: { reason: "permission denied" } });
	});
	it("allows a clean yes", async () => {
		const gate = permissionGate({ requiresApproval: () => true, approve: async () => true });
		expect(await gate(ev)).toBeUndefined();
	});
});
