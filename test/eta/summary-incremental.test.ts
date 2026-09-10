import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import {
	DEFAULT_COMPACTION_SETTINGS,
	generateSummaryWithRequest,
	prepareCompaction,
	type SummaryRequest,
} from "../../src/harness/compaction/compaction.ts";
import type { Entry } from "../../src/harness/session/types.ts";
import { UPDATE_SUMMARIZATION_PROMPT } from "../../src/prompts/compaction.ts";

const user = (id: string, text: string): Entry => ({
	type: "message",
	id,
	parentId: null,
	seq: 1,
	timestamp: 1,
	message: { role: "user", content: text, timestamp: 1 } as never,
});

const assistant = (id: string, text: string): Entry => ({
	type: "message",
	id,
	parentId: null,
	seq: 1,
	timestamp: 1,
	message: { role: "assistant", content: text, timestamp: 1, usage: undefined } as never,
});

describe("P2 incremental summaries", () => {
	it("second compaction updates the previous summary instead of redoing it", () => {
		const entries: Entry[] = [
			user("u1", "old work"),
			{
				type: "compaction",
				id: "c1",
				parentId: "u1",
				seq: 2,
				timestamp: 2,
				summary: "OLD NOTES",
				retainedTail: [],
				tokensBefore: 100,
				fromHook: false,
			},
			user("u2", "new work"),
			assistant("a2", "did new work"),
		];
		const prepared = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(prepared.ok).toBe(true);
		expect(prepared.ok && prepared.value?.previousSummary).toBe("OLD NOTES");
	});

	it("update prompt carries the previous summary; first-time prompt does not", async () => {
		const captured: string[] = [];
		const request: SummaryRequest = async (aiContext) => {
			captured.push(JSON.stringify(aiContext));
			return fauxAssistantMessage("notes");
		};
		const messages = [user("u1", "hello")] as never;
		await generateSummaryWithRequest(
			messages,
			{ model: { id: "m", api: "faux" } as never, reserveTokens: 100, previousSummary: "OLD NOTES" },
			request,
			BACKGROUND_CONTEXT,
		);
		await generateSummaryWithRequest(
			messages,
			{ model: { id: "m", api: "faux" } as never, reserveTokens: 100 },
			request,
			BACKGROUND_CONTEXT,
		);
		expect(captured[0]).toContain("OLD NOTES");
		expect(captured[0]).toContain(UPDATE_SUMMARIZATION_PROMPT.slice(0, 40));
		expect(captured[1]).not.toContain("OLD NOTES");
	});
});
