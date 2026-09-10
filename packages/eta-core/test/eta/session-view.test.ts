import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { EtaAgent } from "../../src/harness/agent.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../src/harness/session/session.ts";
import {
	contextShare,
	SessionViewProjector,
	VIEW_MESSAGE_WINDOW,
	type SessionView,
} from "../../src/harness/session-view.ts";
import type { Entry } from "../../src/harness/session/types.ts";

const CTX = BACKGROUND_CONTEXT;

const messageEntry = (id: string, seq: number, message: object): Entry =>
	({ id, parentId: null, seq, timestamp: 1, type: "message", message }) as Entry;

describe("contextShare", () => {
	it("counts the whole transcript while nothing has been compacted", () => {
		const share = contextShare([
			messageEntry("e1", 1, { role: "user", content: "USER ONE", timestamp: 1 }),
			messageEntry("e2", 2, fauxAssistantMessage([fauxText("ASSISTANT ONE")])),
		]);
		expect(share.userChars).toBe("USER ONE".length);
		expect(share.assistantChars).toBe("ASSISTANT ONE".length);
	});

	it("drops what a compaction removed and counts the summary and the retained tail", () => {
		const entries: Entry[] = [
			messageEntry("e1", 1, { role: "user", content: "COMPACTED AWAY QUESTION", timestamp: 1 }),
			messageEntry("e2", 2, fauxAssistantMessage([fauxText("COMPACTED AWAY ANSWER")])),
			{
				id: "c1",
				parentId: "e2",
				seq: 3,
				timestamp: 2,
				type: "compaction",
				summary: "THE SUMMARY",
				tokensBefore: 900,
				fromHook: false,
				retainedTail: [fauxAssistantMessage([fauxText("RETAINED TAIL")])],
			},
			messageEntry("e3", 4, { role: "user", content: "LIVE QUESTION", timestamp: 3 }),
			messageEntry("e4", 5, {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				content: [{ type: "text", text: "TOOL OUTPUT" }],
				isError: false,
				timestamp: 4,
			}),
		];
		const share = contextShare(entries);
		expect(share.userChars).toBe("LIVE QUESTION".length);
		expect(share.assistantChars).toBe("THE SUMMARY".length + "RETAINED TAIL".length);
		expect(share.toolChars).toBe("TOOL OUTPUT".length);
	});

	it("measures from the newest compaction on the path", () => {
		const entries: Entry[] = [
			messageEntry("e1", 1, { role: "user", content: "OLDEST ROUND", timestamp: 1 }),
			{
				id: "c1",
				parentId: "e1",
				seq: 2,
				timestamp: 2,
				type: "compaction",
				summary: "FIRST SUMMARY THAT THE SECOND COMPACTION REPLACED",
				tokensBefore: 900,
				fromHook: false,
				retainedTail: [],
			},
			messageEntry("e2", 3, { role: "user", content: "MIDDLE ROUND", timestamp: 3 }),
			{
				id: "c2",
				parentId: "e2",
				seq: 4,
				timestamp: 4,
				type: "compaction",
				summary: "SECOND SUMMARY",
				tokensBefore: 1200,
				fromHook: false,
				retainedTail: [],
			},
			messageEntry("e3", 5, { role: "user", content: "NEWEST ROUND", timestamp: 5 }),
		];
		const share = contextShare(entries);
		expect(share.userChars).toBe("NEWEST ROUND".length);
		expect(share.assistantChars).toBe("SECOND SUMMARY".length);
	});
});

describe("SessionView projector", () => {
	it("persona cards ride the stable block and show up in the view", async () => {
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage([fauxText("hi")])]);
		const models = createModels();
		models.setProvider(faux.provider);
		const session = new StorageBackedSession(
			{ id: "eta-persona", createdAt: Date.now(), storageVersion: 1 },
			new MemoryStorage(),
		);
		const agent = await EtaAgent.create(
			{
				session,
				models,
				model: faux.getModel(),
				baseSystemPrompt: "you are eta",
				persona: { names: ["pilot"], text: "PILOT CARD TEXT" },
				heartbeatMs: 0,
			},
			CTX,
		);
		const snapshot = await new SessionViewProjector(agent).snapshot(CTX);
		expect(snapshot.personas).toEqual(["pilot"]);
		await agent.lane.prompt("go", undefined, CTX);
		const view = await new SessionViewProjector(agent).snapshot(CTX);
		expect(view.personas).toEqual(["pilot"]);
		expect(view.prompt!.stableChars).toBeGreaterThanOrEqual("you are eta".length + "PILOT CARD TEXT".length);
	});

	it("windows the transcript and reports how many older rows exist", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const session = new StorageBackedSession(
			{ id: "eta-window", createdAt: Date.now(), storageVersion: 1 },
			new MemoryStorage(),
		);
		const agent = await EtaAgent.create(
			{ session, models, model: faux.getModel(), baseSystemPrompt: "base", heartbeatMs: 0 },
			CTX,
		);
		for (let i = 0; i < VIEW_MESSAGE_WINDOW + 5; i += 1) {
			await agent.lane.appendMessage({ role: "user", content: `m${i}` } as never, CTX);
		}
		const view = await new SessionViewProjector(agent).snapshot(CTX);
		expect(view.messages).toHaveLength(VIEW_MESSAGE_WINDOW);
		expect(view.messagesBefore).toBe(5);
		expect(JSON.stringify(view.messages[0]?.message)).toContain("m5");
	});

	it("contextShare splits the transcript by role and counts tool definitions", async () => {
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
		const models = createModels();
		models.setProvider(faux.provider);
		const session = new StorageBackedSession(
			{ id: "eta-share", createdAt: Date.now(), storageVersion: 1 },
			new MemoryStorage(),
		);
		const agent = await EtaAgent.create(
			{ session, models, model: faux.getModel(), baseSystemPrompt: "base", heartbeatMs: 0 },
			CTX,
		);
		await agent.lane.prompt("hello user text", undefined, CTX);
		await agent.lane.appendMessage(
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				content: [{ type: "text", text: "X".repeat(400) }],
				isError: false,
				timestamp: 1,
			} as never,
			CTX,
		);
		const view = await new SessionViewProjector(agent).snapshot(CTX);
		expect(view.contextShare?.userChars).toBeGreaterThanOrEqual("hello user text".length);
		expect(view.contextShare?.assistantChars).toBeGreaterThanOrEqual("ok".length);
		expect(view.contextShare?.toolChars).toBeGreaterThanOrEqual(400);
		expect(view.contextShare?.toolDefChars).toBeGreaterThan(1000);
	});

	it("falls back after a real compaction instead of holding its water level", async () => {
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage([fauxText("one")]),
			fauxAssistantMessage([fauxText("two")]),
			fauxAssistantMessage([fauxText("three")]),
			fauxAssistantMessage([fauxText("four")]),
			fauxAssistantMessage([fauxText("five")]),
			fauxAssistantMessage([fauxText("THE COMPACTION SUMMARY")]),
		]);
		const models = createModels();
		models.setProvider(faux.provider);
		const session = new StorageBackedSession(
			{ id: "eta-compact", createdAt: Date.now(), storageVersion: 1 },
			new MemoryStorage(),
		);
		const agent = await EtaAgent.create(
			{ session, models, model: faux.getModel(), baseSystemPrompt: "base", heartbeatMs: 0 },
			CTX,
		);
		const projector = new SessionViewProjector(agent);
		for (const prompt of ["one", "two", "three", "four", "five"]) {
			await agent.lane.prompt(`${prompt} ${" ".repeat(40_000)}`, undefined, CTX);
		}
		const before = await projector.snapshot(CTX);
		expect(before.compactionEpoch).toBe(0);
		const beforeChars = before.contextShare!.userChars + before.contextShare!.assistantChars;

		await agent.lane.compact(undefined, CTX);
		const after = await projector.snapshot(CTX);
		expect(after.compactionEpoch).toBe(1);
		expect(after.contextShare!.userChars + after.contextShare!.assistantChars).toBeLessThan(beforeChars);
		// The summary stands in for what was dropped, and the transcript itself
		// keeps showing the whole history.
		expect(after.contextShare!.assistantChars).toBeGreaterThanOrEqual("THE COMPACTION SUMMARY".length);
		expect(after.messages).toHaveLength(before.messages.length);
		await agent.harness.close(CTX);
	}, 30_000);

	it("applyPersona swaps the persona card and rebuilds prompt blocks mid-session", async () => {
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])]);
		const models = createModels();
		models.setProvider(faux.provider);
		const session = new StorageBackedSession(
			{ id: "eta-persona-swap", createdAt: Date.now(), storageVersion: 1 },
			new MemoryStorage(),
		);
		const agent = await EtaAgent.create(
			{
				session,
				models,
				model: faux.getModel(),
				baseSystemPrompt: "you are eta",
				persona: { names: ["Thinker"], text: "OLD CARD TEXT AAAAAAAAAAAAAAAA" },
				heartbeatMs: 0,
			},
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
		const agent = await EtaAgent.create(
			{ session, models, model: faux.getModel(), baseSystemPrompt: "you are eta", heartbeatMs: 0 },
			CTX,
		);

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
