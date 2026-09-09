import { describe, expect, it } from "vitest";
import { AskRegistry, askResponseText, createAskUserTool } from "../../src/harness/ask.ts";
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
			{ type: "ask", payload: { questionId: "q1", question: "still open" } },
			{ type: "ask", payload: { questionId: "q2", question: "answered" } },
			{ type: "answer", payload: { questionId: "q2", answers: ["x"] } },
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

describe("headless ask fallback", () => {
	it("degrades to the text protocol instead of hanging", async () => {
		const reg = new AskRegistry({
			headless: async (payload) => ({ kind: "freeform", text: `plain answer to ${payload.question}` }),
		});
		const answer = await reg.ask({ questionId: "h1", question: "which?" });
		expect(answer).toEqual({ kind: "freeform", text: "plain answer to which?" });
		expect(reg.pendingAsks()).toEqual([]);
	});

	it("null or throwing resolver yields no answer, never a hang", async () => {
		expect(await new AskRegistry({ headless: async () => null }).ask({ questionId: "n", question: "?" })).toEqual({ kind: "none" });
		expect(
			await new AskRegistry({
				headless: () => {
					throw new Error("no terminal");
				},
			}).ask({ questionId: "x", question: "?" }),
		).toEqual({ kind: "none" });
	});
});

describe("answer recording", () => {
	it("a real answer reports its payload; none stays silent", async () => {
		const written: unknown[] = [];
		const reg = new AskRegistry({ onAnswer: (payload) => written.push(payload) });
		const asked = reg.ask({ questionId: "q9", question: "pick" });
		reg.answer("q9", { kind: "freeform", text: "zork" });
		await asked;
		reg.answer("gone", { kind: "none" });
		expect(written).toEqual([{ questionId: "q9", answers: ["zork"] }]);
	});
});
