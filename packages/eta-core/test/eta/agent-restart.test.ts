/**
 * End-to-end restart proof: battery state written through the live agent
 * (entries + session values) must rebuild from storage in a fresh agent.
 */

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { EtaAgent } from "../../src/harness/agent.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../src/harness/session/session.ts";
import type { AnswerPayload, GoalPayload } from "../../src/harness/session/types.ts";

const CTX = BACKGROUND_CONTEXT;

interface Opened {
	agent: EtaAgent;
	turn(): Promise<void>;
	faux: ReturnType<typeof fauxProvider>;
}

async function openAgent(storage: MemoryStorage, laneName: string): Promise<Opened> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const session = new StorageBackedSession({ id: laneName, createdAt: Date.now(), storageVersion: 1 }, storage);
	const agent = await EtaAgent.create(
		{ session, models, model: faux.getModel(), baseSystemPrompt: "x", heartbeatMs: 0 },
		CTX,
	);
	return {
		agent,
		faux,
		turn: async () => {
			faux.setResponses([fauxAssistantMessage([fauxText("ok")] as never)]);
			await agent.lane.prompt("go", undefined, CTX);
		},
	};
}

describe("restart through storage", () => {
	it("an operation suspended at kill time is adopted by restore, not wedged", async () => {
		const storage = new MemoryStorage();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const open = () =>
			EtaAgent.create(
				{
					session: new StorageBackedSession(
						{ id: "eta-wedge", createdAt: Date.now(), storageVersion: 1 },
						storage,
					),
					models,
					model: faux.getModel(),
					baseSystemPrompt: "x",
					heartbeatMs: 0,
				},
				CTX,
			);
		const first = await open();
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("ask_user", { question: "which theme?", options: [{ title: "dark" }, { title: "light" }] }),
			] as never),
			fauxAssistantMessage([fauxText("theme locked")] as never),
		]);
		void first.lane.prompt("pick a theme", undefined, CTX);
		for (let attempt = 0; attempt < 400 && first.ask.pendingAsks().length === 0; attempt += 1)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(first.ask.pendingAsks()[0]?.question).toBe("which theme?");

		const second = await open();
		await second.restore(CTX);
		// restore adopts the durable running operation (lane.resume): the ask re-surfaces and
		// the lane still tracks the operation, so a later answer or steer can take it over.
		const pending = second.ask.pendingAsks()[0];
		expect(pending?.question).toBe("which theme?");
		const execution = await second.lane.inspectExecution(CTX);
		expect(execution.current).not.toBeNull();
	});

	it("a real answer is recorded as an answer entry", async () => {
		const { agent, turn } = await openAgent(new MemoryStorage(), "eta-answer");
		const asked = agent.ask.ask({ questionId: "q1", question: "which?", options: ["a", "b"] });
		expect(agent.ask.answer("q1", { kind: "selection", selections: ["a"] })).toBe(true);
		expect(await asked).toEqual({ kind: "selection", selections: ["a"] });
		await turn();
		const entries = await agent.lane.findEntries(undefined, CTX);
		const answer = entries.find((e) => e.type === "answer");
		expect((answer as { payload: AnswerPayload } | undefined)?.payload.answers).toEqual(["a"]);
	});

	it("goal and tasks survive a restart with ids intact", async () => {
		const storage = new MemoryStorage();
		const first = await openAgent(storage, "eta-restart");
		first.agent.goal.set("ship the restart test");
		const create = first.agent.agentTools.find((t) => t.name === "TaskCreate")!;
		await create.execute("c1", { content: "persist me" }, () => {}, undefined, {} as never, CTX);
		expect(first.agent.setTask("t1", { status: "in_progress" })?.task.status).toBe("in_progress");
		await first.turn();

		const second = await openAgent(storage, "eta-restart");
		await second.agent.restore(CTX);
		expect(second.agent.goal.current?.objective).toBe("ship the restart test");
		expect(second.agent.tasks.list().map((t) => [t.id, t.content, t.status])).toEqual([
			["t1", "persist me", "in_progress"],
		]);
		expect(second.agent.tasks.create("fresh").task.id).toBe("t2");
	});

	it("a fired loop's registry value survives the restart", async () => {
		// The run-end driver also pumps. Storage recovery must not depend on a turn
		// finishing in under 10ms on the machine running the suite.
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
		try {
			const storage = new MemoryStorage();
			const first = await openAgent(storage, "eta-loop");
			first.agent.loops.upsert({
				def: { id: "tick", note: "check ci", every: "10ms" },
				runCount: 0,
				createdAt: Date.now(),
				nextDueAt: Date.now() - 1,
				paused: false,
			});
			expect(first.agent.loops.pump(Date.now() + 1).fired).toHaveLength(1);
			const nextDueAt = first.agent.loops.list()[0]!.nextDueAt!;
			await first.turn();
			const second = await openAgent(storage, "eta-loop");
			await second.agent.restore(CTX);
			const specs = second.agent.loops.list();
			expect(specs.map((spec) => [spec.def.id, spec.runCount])).toEqual([["tick", 1]]);
			expect(specs[0]!.nextDueAt).toBe(nextDueAt);
			expect(second.agent.loops.pump(nextDueAt - 1).fired).toHaveLength(0);
			expect(second.agent.loops.pump(nextDueAt).fired[0]!.spec.runCount).toBe(2);
		} finally {
			clock.mockRestore();
		}
	});

	it("an ask pending at kill time re-surfaces from durable pending values", async () => {
		const storage = new MemoryStorage();
		const first = await openAgent(storage, "eta-kill");
		first.faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("ask_user", { question: "which theme?", options: [{ title: "dark" }, { title: "light" }] }),
			] as never),
			fauxAssistantMessage([fauxText("theme locked")] as never),
		]);
		const run = first.agent.lane.prompt("pick a theme", undefined, CTX);
		for (let attempt = 0; attempt < 100 && first.agent.ask.pendingAsks().length === 0; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(first.agent.ask.pendingAsks()[0]?.question).toBe("which theme?");

		const second = await openAgent(storage, "eta-kill");
		await second.agent.restore(CTX);
		const reSurfaced = second.agent.ask.pendingAsks()[0];
		expect(reSurfaced?.question).toBe("which theme?");
		expect(second.agent.ask.answer(reSurfaced!.questionId, { kind: "selection", selections: ["dark"] })).toBe(true);

		first.agent.ask.answer(first.agent.ask.pendingAsks()[0]!.questionId, { kind: "selection", selections: ["dark"] });
		await run;
		const types = (await first.agent.lane.findEntries(undefined, CTX)).map((e) => e.type);
		expect(types).toContain("ask");
		expect(types).toContain("answer");
	});

	it("goal entries replay in order and the achieved state wins", async () => {
		const storage = new MemoryStorage();
		const first = await openAgent(storage, "eta-goal");
		first.agent.goal.set("do it");
		first.agent.goal.markAchieved();
		await first.turn();
		const second = await openAgent(storage, "eta-goal");
		await second.agent.restore(CTX);
		const entries = await second.agent.lane.findEntries(undefined, CTX);
		const goals = entries.filter((e) => e.type === "goal").sort((a, b) => a.seq - b.seq);
		expect(goals.map((g) => (g as { payload: GoalPayload }).payload.kind)).toEqual(["set", "achieved"]);
		expect(second.agent.goal.current?.status).toBe("achieved");
	});
});
