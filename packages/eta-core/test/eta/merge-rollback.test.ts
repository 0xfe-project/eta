import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../src/harness/session/session.ts";
import type { AgentMessage } from "../../src/types.ts";

const CTX = BACKGROUND_CONTEXT;
const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 }) as unknown as AgentMessage;

describe("D4 merge and rollback", () => {
	it("fork -> commit -> merge -> rollback", async () => {
		const storage = new MemoryStorage();
		const session = new StorageBackedSession({ id: "s", createdAt: Date.now(), storageVersion: 1 }, storage);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const { harness } = await AgentHarness.create(
			{ session, models, model: faux.getModel(), activeToolNames: [], tools: [] },
			CTX,
		);
		const lane = await harness.lane("main", CTX);

		const shared = await lane.appendMessage(user("shared history"), CTX);
		const side = await session.createBranch("side", shared, CTX);
		const sideEntry = await side.appendMessage(user("side work"), CTX);
		const mainWork = await lane.appendMessage(user("main work"), CTX);

		const mergeId = await lane.mergeBranch("side", CTX);
		const path = await lane.findEntries({ order: "oldestFirst" }, CTX);
		const ids = path.map((entry) => entry.id);
		expect(ids).toEqual([shared, mainWork, sideEntry, mergeId]);
		expect(path.find((entry) => entry.id === mergeId)?.type).toBe("merge");

		const merged = await lane.findEntries({ type: "message", order: "oldestFirst" }, CTX);
		const texts = merged.flatMap((entry) =>
			entry.type === "message" ? [String((entry.message as { content?: string }).content)] : [],
		);
		expect(texts).toEqual(["shared history", "main work", "side work"]);

		const rolled = (await lane.rollback(mainWork, CTX)) as { ok: boolean };
		expect(rolled.ok).toBe(true);
		const after = await lane.findEntries({ order: "oldestFirst" }, CTX);
		expect(after.map((entry) => entry.id)).toEqual([shared, mainWork]);

		void harness.close(CTX);
		void storage.close(CTX);
	});
});
