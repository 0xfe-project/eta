/**
 * What "total tokens this session" means, and what is not allowed to move it.
 *
 * The Context panel shows one number for a whole session's cost. It is read after a
 * compaction more often than before one — compaction is what happens when a session gets
 * long enough to be expensive — so the failure mode worth guarding is a total that quietly
 * collapses to the surviving window and tells the user a session they spent an hour on
 * suddenly cost almost nothing.
 */
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { EtaAgent } from "../../src/harness/agent.ts";
import { FileStorage } from "../../src/harness/session/file-storage.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../src/harness/session/session.ts";
import { SessionViewProjector } from "../../src/harness/session-view.ts";
import { sessionTokenTotal } from "../../src/harness/utils/usage.ts";

const CTX = BACKGROUND_CONTEXT;
const dirs: string[] = [];

const summaryFaux = () => {
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxText("one")]),
		fauxAssistantMessage([fauxText("two")]),
		fauxAssistantMessage([fauxText("three")]),
		fauxAssistantMessage([fauxText("THE COMPACTION SUMMARY")]),
	]);
	return faux;
};

async function agentOver(faux: ReturnType<typeof fauxProvider>, storagePath?: string): Promise<EtaAgent> {
	const models = createModels();
	models.setProvider(faux.provider);
	const session =
		storagePath === undefined
			? new StorageBackedSession({ id: "eta-total", createdAt: Date.now(), storageVersion: 1 }, new MemoryStorage())
			: new StorageBackedSession(
					{ id: "eta-total", createdAt: Date.now(), storageVersion: 1 },
					await FileStorage.load({ path: storagePath, now: () => Date.now() }, CTX),
				);
	return EtaAgent.create({ session, models, model: faux.getModel(), baseSystemPrompt: "base", heartbeatMs: 0 }, CTX);
}

describe("session token total", () => {
	it("survives a compaction, which charges the summary call instead of refunding the day", async () => {
		const faux = summaryFaux();
		const agent = await agentOver(faux);
		const projector = new SessionViewProjector(agent);
		for (const prompt of ["one", "two", "three"]) {
			await agent.lane.prompt(`${prompt} ${"x".repeat(40_000)}`, undefined, CTX);
		}
		const before = await projector.snapshot(CTX);
		const beforeTotal = sessionTokenTotal(before.usage);
		expect(beforeTotal).toBeGreaterThan(0);

		await agent.lane.compact(undefined, CTX);
		const after = await projector.snapshot(CTX);

		// The compaction really happened: the window it will send got smaller.
		expect(after.compactionEpoch).toBe(1);
		expect(after.contextShare!.userChars + after.contextShare!.assistantChars).toBeLessThan(
			before.contextShare!.userChars + before.contextShare!.assistantChars,
		);
		// And yet nothing was forgiven. The summarizer's own call is charged on top, so the
		// session total only ever moves up — never back to the surviving window's estimate.
		expect(sessionTokenTotal(after.usage)).toBeGreaterThan(beforeTotal);
		await agent.harness.close(CTX);
	}, 30_000);

	it("is the same number after the session is reopened from its journal", async () => {
		const dir = await mkdtemp(join(tmpdir(), "eta-usage-"));
		dirs.push(dir);
		const path = join(dir, "journal.jsonl");
		const faux = summaryFaux();
		const agent = await agentOver(faux, path);
		await agent.lane.prompt(`first ${"x".repeat(5_000)}`, undefined, CTX);
		await agent.lane.prompt(`second ${"x".repeat(5_000)}`, undefined, CTX);
		const written = sessionTokenTotal(await new SessionViewProjector(agent).snapshot(CTX).then((view) => view.usage));
		await agent.harness.close(CTX);
		expect(written).toBeGreaterThan(0);

		// Reopen: the journal holds every usage row ever committed, so the running total is
		// rebuilt from them rather than from whatever context happens to still be resident.
		const reopenedFaux = summaryFaux();
		const reopened = await agentOver(reopenedFaux, path);
		const reopenedTotal = sessionTokenTotal(await new SessionViewProjector(reopened).snapshot(CTX).then((view) => view.usage));
		await reopened.harness.close(CTX);
		expect(reopenedTotal).toBe(written);
	});

	it("falls back to the parts when a provider reports none of the sum", () => {
		expect(sessionTokenTotal(undefined)).toBe(0);
		expect(
			sessionTokenTotal({
				input: 100,
				output: 40,
				cacheRead: 10,
				cacheWrite: 5,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			}),
		).toBe(155);
		// A provider that does report a sum wins, even where the parts disagree: it is the
		// number the bill is drawn from.
		expect(
			sessionTokenTotal({
				input: 100,
				output: 40,
				cacheRead: 10,
				cacheWrite: 5,
				totalTokens: 999,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			}),
		).toBe(999);
	});
});

afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});
