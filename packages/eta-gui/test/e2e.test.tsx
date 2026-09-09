/**
 * T3: the whole mixed session — goal, tasks, ask, compaction, loop, btw,
 * subagents, KV — driven through the GUI's own channels and asserted through
 * the automation tree. The faux model stands in for a real one (same drive
 * path); golden screenshots land in test/_goldens/.
 */

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT, EtaAgent, MemoryStorage, StorageBackedSession } from "@eta/core";
import { connectTest } from "@gpuix/react/automation";
import { createTestRoot, hasNativeTestRenderer } from "@gpuix/react/testing";
import { mkdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Host } from "../src/host.ts";
import { LiveApp } from "../src/main.tsx";
import { EtaApp, noOps } from "../src/app.tsx";
import { fakeFeed } from "../src/fake.ts";

const describeNative = hasNativeTestRenderer ? describe : describe.skip;

async function settle(predicate: () => boolean, rounds = 300): Promise<void> {
	for (let attempt = 0; attempt < rounds && !predicate(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

const GOLDENS = new URL("_goldens/", import.meta.url).pathname;

describeNative("T2 goldens", () => {
	it("context, dev and timeline panels capture deterministic screenshots", async () => {
		mkdirSync(GOLDENS, { recursive: true });
		const feed = fakeFeed();
		const { render, renderer } = createTestRoot();
		render(<EtaApp sessions={feed.sessions} active="eta-main" view={feed.view} dev={feed.dev} ops={noOps} defaultTab="context" />);
		await connectTest(renderer);
		renderer.captureScreenshot(`${GOLDENS}context.png`);
		const first = readFileSync(`${GOLDENS}context.png`);
		renderer.captureScreenshot(`${GOLDENS}context-again.png`);
		expect(readFileSync(`${GOLDENS}context-again.png`).equals(first)).toBe(true);
		expect(first.length).toBeGreaterThan(1000);

		const second = createTestRoot();
		second.render(<EtaApp sessions={feed.sessions} active="eta-main" view={feed.view} dev={feed.dev} ops={noOps} />);
		await connectTest(second.renderer);
		second.renderer.captureScreenshot(`${GOLDENS}dev.png`);
		expect(readFileSync(`${GOLDENS}dev.png`).length).toBeGreaterThan(1000);
	});
});

describeNative("T3 mixed session", () => {
	it("every battery paints, updates, and drives back through the GUI", async () => {
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("TaskCreate", { content: "wire the mixed session" })] as never),
			fauxAssistantMessage([fauxToolCall("ask_user", { question: "prod or staging?", options: [{ title: "prod" }, { title: "staging" }] })] as never),
			fauxAssistantMessage([fauxText("shipped to staging")] as never),
			fauxAssistantMessage("compact summary of the mixed session"),
		] as never);
		const models = createModels();
		models.setProvider(faux.provider);
		const storage = new MemoryStorage();
		const session = new StorageBackedSession({ id: "eta-mixed", createdAt: Date.now(), storageVersion: 1 }, storage);
		const agent = await EtaAgent.create({ session, models, model: faux.getModel(), heartbeatMs: 0, baseSystemPrompt: "you are eta" }, BACKGROUND_CONTEXT);

		const host = new Host();
		await host.open("mixed", async () => agent);
		const { render, renderer } = createTestRoot();
		render(<LiveApp host={host} />);
		const app = await connectTest(renderer);

		const composer = app.getByTestId("composer");
		await composer.fill("go");
		await composer.press("enter");

		await settle(() => renderer.getPaintedText().some((line) => line.includes("prod or staging?")));
		await app.getByTestId("ask-option-prod").click();
		await settle(() => renderer.getPaintedText().some((line) => line.includes("shipped to staging")));
		await settle(() => !(host.sidebar()[0]?.badges.includes("running") ?? true));
		await host.compact("mixed");

		host.btwOpen("mixed", "tangent");
		await settle(() => (host.viewOf("mixed")?.sideThread.length ?? 0) >= 1);
		const threadId = host.viewOf("mixed")!.sideThread[0]!.id;
		host.btwAnswer("mixed", threadId, "side note", "noted");
		host.btwSave("mixed", threadId);
		host.stateSet("mixed", "build.cmd", "bun test");
		host.agentOf("mixed")!.subagents.spawn({ prompt: "dig the repo" });
		await settle(() => (host.viewOf("mixed")?.subagents.length ?? 0) >= 1);
		const subagentId = host.viewOf("mixed")!.subagents[0]!.id;
		host.goal("mixed", "set", "ship the mixed session");
		host.agentOf("mixed")!.loops.upsert({ def: { id: "tick", note: "check ci", every: "1s" }, runCount: 0, createdAt: Date.now(), nextDueAt: Date.now() - 1, paused: false });
		host.agentOf("mixed")!.loops.pump(Date.now() + 1);

		await settle(() => {
			const v = host.viewOf("mixed")!;
			return (
				v.compactionEpoch >= 1 &&
				v.goal?.objective === "ship the mixed session" &&
				v.sideThread.some((t) => t.saveState === "saved") &&
				v.stateKeys.includes("build.cmd") &&
				v.subagents.length >= 1 &&
				v.loops.some((l) => l.runCount >= 1)
			);
		});

		const view = host.viewOf("mixed")!;
		expect(view.systems.some((row) => row.kind === "compaction" && row.text.includes("compact summary"))).toBe(true);
		expect(view.messages.some((m) => JSON.stringify(m.message).includes("shipped to staging"))).toBe(true);
		expect(view.pendingAsk).toBeUndefined();

		await app.getByTestId("tab-context").click();
		await new Promise((resolve) => setTimeout(resolve, 30));
		const painted = renderer.getPaintedText();
		const has = (needle: string) => painted.some((line) => line.includes(needle));
		expect(has("goal: ship the mixed session (active)")).toBe(true);
		expect(has("wire the mixed session")).toBe(true);
		expect(has("kv build.cmd")).toBe(true);
		expect(has(`agent ${subagentId}`)).toBe(true);
		expect(has("check ci")).toBe(true);
		expect(has(`btw ${threadId} · 1x · saved`)).toBe(true);
		expect(has("prod or staging?")).toBe(true);
		expect(painted.some((line) => line.startsWith("ask:"))).toBe(true);
		mkdirSync(GOLDENS, { recursive: true });
		renderer.captureScreenshot(`${GOLDENS}mixed.png`);

		await host.close();
	});
});
