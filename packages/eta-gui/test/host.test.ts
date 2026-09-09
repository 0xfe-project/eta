import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT, EtaAgent, MemoryStorage, StorageBackedSession } from "@eta/core";
import { describe, expect, it } from "vitest";
import { Host } from "../src/host.ts";
import type { ChannelFrame } from "../src/channels.ts";

const makeAgent = async (id: string, heartbeatMs: number) => {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("hello back")]);
	const models = createModels();
	models.setProvider(faux.provider);
	const storage = new MemoryStorage();
	const session = new StorageBackedSession({ id, createdAt: Date.now(), storageVersion: 1 }, storage);
	return EtaAgent.create({ session, models, model: faux.getModel(), heartbeatMs }, BACKGROUND_CONTEXT);
};

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
});