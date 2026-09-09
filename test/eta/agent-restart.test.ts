/**
 * End-to-end restart proof: battery state written through the live agent
 * (entries + session values) must rebuild from storage in a fresh agent.
 */

import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { EtaAgent } from "../../src/harness/agent.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../src/harness/session/session.ts";
import type { AnswerPayload, GoalPayload } from "../../src/harness/session/types.ts";

const CTX = BACKGROUND_CONTEXT;

interface Opened {
	agent: EtaAgent;
	turn(): Promise<void>;
}

async function openAgent(storage: MemoryStorage, laneName: string): Promise<Opened> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const session = new StorageBackedSession({ id: laneName, createdAt: Date.now(), storageVersion: 1 }, storage);
	const agent = await EtaAgent.create({ session, models, model: faux.getModel(), baseSystemPrompt: "x", heartbeatMs: 0 }, CTX);
	return {
		agent,
		turn: async () => {
			faux.setResponses([fauxAssistantMessage([fauxText("ok")] as never)]);
			await agent.lane.prompt("go", undefined, CTX);
		},
	};
}

describe("restart through storage", () => {
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
		expect(second.agent.tasks.list().map((t) => [t.id, t.content, t.status])).toEqual([["t1", "persist me", "in_progress"]]);
		expect(second.agent.tasks.create("fresh").task.id).toBe("t2");
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
