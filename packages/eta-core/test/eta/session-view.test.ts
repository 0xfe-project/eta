import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { EtaAgent } from "../../src/harness/agent.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../src/harness/session/session.ts";
import { SessionViewProjector, type SessionView } from "../../src/harness/session-view.ts";

const CTX = BACKGROUND_CONTEXT;

describe("SessionView projector", () => {
	it("persona cards ride the stable block and show up in the view", async () => {
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage([fauxText("hi")])]);
		const models = createModels();
		models.setProvider(faux.provider);
		const session = new StorageBackedSession({ id: "eta-persona", createdAt: Date.now(), storageVersion: 1 }, new MemoryStorage());
		const agent = await EtaAgent.create(
			{ session, models, model: faux.getModel(), baseSystemPrompt: "you are eta", persona: { names: ["pilot"], text: "PILOT CARD TEXT" }, heartbeatMs: 0 },
			CTX,
		);
		const snapshot = await new SessionViewProjector(agent).snapshot(CTX);
		expect(snapshot.personas).toEqual(["pilot"]);
		await agent.lane.prompt("go", undefined, CTX);
		const view = await new SessionViewProjector(agent).snapshot(CTX);
		expect(view.personas).toEqual(["pilot"]);
		expect(view.prompt!.stableChars).toBeGreaterThanOrEqual("you are eta".length + "PILOT CARD TEXT".length);
	});

	it("applyPersona swaps the persona card and rebuilds prompt blocks mid-session", async () => {
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])]);
		const models = createModels();
		models.setProvider(faux.provider);
		const session = new StorageBackedSession({ id: "eta-persona-swap", createdAt: Date.now(), storageVersion: 1 }, new MemoryStorage());
		const agent = await EtaAgent.create(
			{ session, models, model: faux.getModel(), baseSystemPrompt: "you are eta", persona: { names: ["Thinker"], text: "OLD CARD TEXT AAAAAAAAAAAAAAAA" }, heartbeatMs: 0 },
			CTX,
		);
		const projector = new SessionViewProjector(agent);
		await agent.lane.prompt("go", undefined, CTX);
		expect((await projector.snapshot(CTX)).personas).toEqual(["Thinker"]);
		const stableBefore = (await projector.snapshot(CTX)).prompt!.stableChars;
		agent.applyPersona({ names: ["pilot"], text: "NEW" });
		await agent.refreshPromptBlocks();
		const swapped = await projector.snapshot(CTX);
		expect(swapped.personas).toEqual(["pilot"]);
		expect(stableBefore - swapped.prompt!.stableChars).toBeGreaterThanOrEqual(15);
		await agent.lane.prompt("again", undefined, CTX);
		expect((await projector.snapshot(CTX)).personas).toEqual(["pilot"]);
	});

	it("two attached front-ends converge to the same view", async () => {
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage([
				{ type: "thinking", thinking: "pick a task first", thinkingSignature: "" },
				fauxText("on it"),
			] as never),
		]);
		const models = createModels();
		models.setProvider(faux.provider);
		const storage = new MemoryStorage();
		const session = new StorageBackedSession({ id: "eta-view", createdAt: Date.now(), storageVersion: 1 }, storage);
		const agent = await EtaAgent.create({ session, models, model: faux.getModel(), baseSystemPrompt: "you are eta", heartbeatMs: 0 }, CTX);

		const projectorA = new SessionViewProjector(agent);
		const projectorB = new SessionViewProjector(agent);
		let latestA: SessionView | undefined;
		let updatesA = 0;
		const attachA = await projectorA.attach((view) => {
			latestA = view;
			updatesA += 1;
		}, CTX);
		const attachB = await projectorB.attach(() => undefined, CTX);
		expect(attachB.view).toEqual(attachA.view);
		expect(attachA.view.messages).toHaveLength(0);
		expect(attachA.view.goal).toBeUndefined();

		agent.goal.set("ship the view");
		agent.tasks.create("write the thing");
		await agent.lane.prompt("get started", undefined, CTX);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(updatesA).toBeGreaterThan(0);
		const viewA = latestA!;
		const viewB = await projectorB.snapshot(CTX);
		expect(viewA).toEqual(viewB);

		expect(viewA.goal?.objective).toBe("ship the view");
		expect(viewA.systems.some((row) => row.kind === "goal" && row.args.objective === "ship the view")).toBe(true);
		expect(viewA.compactionEpoch).toBe(0);
		expect(viewA.subagents).toEqual([]);
		expect(viewA.memory).toBeUndefined();
		expect(viewA.tasks).toHaveLength(1);
		expect(viewA.messages.length).toBeGreaterThanOrEqual(2);
		expect(viewA.thinking).toEqual(["pick a task first"]);
		expect(viewA.branch.tipId).not.toBeNull();
		expect(viewA.pendingAsk).toBeUndefined();
		expect(typeof viewA.cacheRate).toBe("number");
		expect(viewA.prompt?.stableChars).toBeGreaterThan(0);
		expect(typeof viewA.tokensPerSec).toBe("number");

		attachA.detach();
		const afterDetach = updatesA;
		await agent.lane.prompt("one more", undefined, CTX).catch(() => undefined);
		expect(updatesA).toBe(afterDetach);

		void agent.harness.close(CTX);
		void storage.close(CTX);
	});
});
