import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT, EtaAgent, MemoryStorage, StorageBackedSession } from "@eta/core";
import { describe, expect, it } from "vitest";
import { Host } from "../src/host.ts";
import type { ChannelFrame } from "../src/channels.ts";

const makeAgent = async (
	id: string,
	heartbeatMs: number,
	options: { storage?: MemoryStorage; responses?: unknown[] } = {},
) => {
	const faux = fauxProvider();
	faux.setResponses((options.responses ?? [fauxAssistantMessage("hello back")]) as never);
	const models = createModels();
	models.setProvider(faux.provider);
	const storage = options.storage ?? new MemoryStorage();
	const session = new StorageBackedSession({ id, createdAt: Date.now(), storageVersion: 1 }, storage);
	return EtaAgent.create({ session, models, model: faux.getModel(), heartbeatMs }, BACKGROUND_CONTEXT);
};

async function settle(predicate: () => boolean, rounds = 100): Promise<void> {
	for (let attempt = 0; attempt < rounds && !predicate(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("host", () => {
	it("G1: a real turn streams to the GUI over all three channels", async () => {
		const host = new Host();
		await host.open("a", () => makeAgent("eta-a", 0));
		const frames: ChannelFrame[] = [];
		host.subscribe((frame) => frames.push(frame));

		await host.prompt("a", "hi");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(frames.some((f) => f.channel === "agent" && f.event.type === "run_start")).toBe(true);
		expect(frames.some((f) => f.channel === "agent" && f.event.type === "message_end")).toBe(true);
		const views = frames.filter((f) => f.channel === "view");
		const last = views[views.length - 1];
		expect(last?.channel === "view" && last.view.messages.length).toBeGreaterThanOrEqual(2);
		const sidebar = host.sidebar();
		expect(sidebar[0]?.name).toBe("a");
		expect(sidebar[0]?.badges).not.toContain("running");
		await host.close();
	});

	it("G0.3: background loops fire while the GUI points elsewhere", async () => {
		const host = new Host();
		await host.open("a", () => makeAgent("eta-a", 0));
		await host.open("b", () => makeAgent("eta-b", 10));
		const frames: ChannelFrame[] = [];
		const unsubscribe = host.subscribe((frame) => frames.push(frame));

		host.agentOf("b")!.loops.upsert({
			def: { id: "tick", note: "check ci", every: "10ms" },
			runCount: 0,
			createdAt: Date.now(),
			nextDueAt: Date.now() - 1,
			paused: false,
		});
		await new Promise((resolve) => setTimeout(resolve, 150));

		expect(host.attachPointer).toBe("a");
		const loopFrames = host.ringOf("b")?.tail("loop") ?? [];
		expect(loopFrames.length).toBeGreaterThan(0);
		expect(frames.some((f) => f.channel === "dev" && f.frame.session === "b" && f.frame.category === "loop")).toBe(true);

		unsubscribe();
		await host.close();
	});

	it("L2: taskSet through the host mutates the store and repaints the view", async () => {
		const host = new Host();
		await host.open("a", () => makeAgent("eta-a", 0));
		const agent = host.agentOf("a")!;
		agent.tasks.create("wire the panel");
		host.taskSet("a", "t1", "completed");
		expect(agent.tasks.get("t1")?.status).toBe("completed");
		for (let attempt = 0; attempt < 20; attempt += 1) {
			if (host.viewOf("a")?.tasks.some((t) => t.id === "t1" && t.status === "completed") === true) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(host.viewOf("a")?.tasks.some((t) => t.id === "t1" && t.status === "completed")).toBe(true);
		await host.close();
	});

	it("G4: an unanswered ask survives a kill, re-surfaces on reopen, and answering settles it", async () => {
		const storage = new MemoryStorage();
		const host = new Host();
		await host.open("a", () =>
			makeAgent("eta-g4", 0, {
				storage,
				responses: [
					fauxAssistantMessage([fauxToolCall("ask_user", { question: "which theme?", options: [{ title: "dark" }, { title: "light" }] })] as never),
					fauxAssistantMessage([fauxText("theme locked")] as never),
				],
			}));
		const run = host.prompt("a", "pick a theme");
		await settle(() => host.viewOf("a")?.pendingAsk !== undefined);
		const qid = host.viewOf("a")!.pendingAsk!.questionId;

		const reopened = new Host();
		await reopened.open("a", () => makeAgent("eta-g4", 0, { storage }), { restore: true });
		expect(reopened.viewOf("a")?.pendingAsk?.questionId).toBe(qid);
		expect(reopened.askOf("a")!.answer(qid, { kind: "selection", selections: ["dark"] })).toBe(true);
		await host.agentOf("a")!.ask.answer(qid, { kind: "selection", selections: ["dark" as never] } as never);
		await run.catch(() => undefined);
		await settle(() => reopened.viewOf("a")?.pendingAsk === undefined);
		await reopened.close();
	});

	it("G5: a manual compaction lands a timeline row and bumps the epoch", async () => {
		const host = new Host();
		await host.open("a", () =>
			makeAgent("eta-g5", 0, {
				responses: [fauxAssistantMessage("first turn"), fauxAssistantMessage("compact summary of the old part")],
			}));
		await host.prompt("a", "go");
		await host.compact("a");
		await settle(() => (host.viewOf("a")?.compactionEpoch ?? 0) >= 1);
		const view = host.viewOf("a")!;
		expect(view.compactionEpoch).toBeGreaterThanOrEqual(1);
		expect(view.systems.some((row) => row.kind === "compaction" && row.text.includes("compact summary"))).toBe(true);
		await host.close();
	});

	it("G7: a spawned subagent shows in the fleet rows", async () => {
		const host = new Host();
		await host.open("a", () => makeAgent("eta-g7", 0));
		host.agentOf("a")!.subagents.spawn({ prompt: "dig the repo" });
		await settle(() => (host.viewOf("a")?.subagents.length ?? 0) >= 1);
		expect(host.viewOf("a")!.subagents[0]).toMatchObject({ status: expect.stringMatching(/queued|running|done/) });
		await host.close();
	});

	it("G8: btw open, inject, save paints the sideThread and a timeline note", async () => {
		const host = new Host();
		await host.open("a", () => makeAgent("eta-g8", 0));
		host.btwOpen("a", "tangent");
		await settle(() => (host.viewOf("a")?.sideThread.length ?? 0) >= 1);
		const threadId = host.viewOf("a")!.sideThread[0]!.id;
		host.btwAnswer("a", threadId, "which editor?", "vim");
		await settle(() => (host.viewOf("a")?.sideThread[0]?.exchanges.length ?? 0) >= 1);
		host.btwSave("a", threadId);
		await settle(() => host.viewOf("a")!.systems.some((row) => row.kind === "btw"));
		const view = host.viewOf("a")!;
		expect(view.sideThread[0]!.saveState).toBe("saved");
		expect(view.systems.some((row) => row.kind === "btw" && row.text.includes("vim"))).toBe(true);
		host.btwClear("a", threadId);
		await settle(() => (host.viewOf("a")?.sideThread.length ?? 1) === 0);
		await host.close();
	});
});