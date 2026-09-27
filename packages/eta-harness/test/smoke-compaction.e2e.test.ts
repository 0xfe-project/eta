/**
 * A real model writing a real compaction summary (REFACTOR.md §6.2).
 *
 * Skipped unless a configuration file is named, like the other smoke tests:
 *
 *   ETA_SMOKE_CONFIG=~/.eta/config.json bun run test test/smoke-compaction.e2e.test.ts
 *
 * What it proves that the scripted tests cannot: a real model reads a real
 * conversation and writes notes in the format the next reader depends on, the
 * kernel swaps the history for them, and the session keeps working on the other
 * side — carrying the earlier decisions forward.
 */

import { etaCompaction } from "@eta/compaction";
import { type AssistantMessage, kernelOn, MemoryStorage, RunPump, SessionLog } from "@eta/core";
import { assistantMessage, realModels, selectProvider } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { openSession } from "../src/index";

const configPath = process.env.ETA_SMOKE_CONFIG;
const modelSelector = process.env.ETA_SMOKE_MODEL;
const TIMEOUT_MS = Number(process.env.ETA_SMOKE_TIMEOUT_MS ?? 240_000);

const userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: Date.now(),
});

/** What a project's history looks like after a few turns of real work. */
const HISTORY: [string, string][] = [
	[
		"We are rewriting the storage layer of eta. Remember this: the project codename is KUMQUAT-7.",
		"Understood — the storage rewrite is KUMQUAT-7.",
	],
	[
		"Decision: the journal stays append-only, and compaction rebuilds it atomically.",
		"Noted: append-only journal, atomic rebuild on compaction.",
	],
	[
		"The branch tip has to be journaled as a value, or a rollback is lost on restart.",
		"Agreed — the tip goes into the journal as a value.",
	],
	["Constraint: no prompt text may live in the kernel package.", "Right, prompts stay in plugins."],
	[
		"Open question: whether the task ledger belongs in the journal too.",
		"It does, under the eta.tasks.state namespace.",
	],
];

describe.skipIf(configPath === undefined)("real model compaction", () => {
	it(
		"summarizes a real history, replaces it, and the session carries on",
		async () => {
			const selected = await selectProvider(configPath!, modelSelector);
			const models = realModels(selected.spec);
			const storage = new MemoryStorage();
			const log = SessionLog.create(storage);

			// A real history, written straight to the journal.
			for (const [question, answer] of HISTORY) {
				log.recordMessage(userMsg(question));
				log.recordMessage(
					assistantMessage({
						content: [{ type: "text", text: answer }],
						stopReason: "stop",
						usage: {
							input: 100,
							output: 20,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 120,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					}) as AssistantMessage as never,
				);
			}
			await log.commit();

			// Keep only the last exchange; everything else gets summarized.
			const opened = await openSession({
				storage,
				models,
				compaction: etaCompaction(),
				config: {
					model: { provider: selected.spec.id, modelId: selected.modelId },
					compaction: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 60, maxContextTokens: 4_000 },
				},
				runner: {
					toProviderMessages: (messages) =>
						messages.flatMap((message) =>
							message.role === "compactionSummary"
								? [
										{
											role: "user" as const,
											content: [
												{
													type: "text" as const,
													text: `Notes from earlier in this session:\n${message.summary}`,
												},
											],
											timestamp: 0,
										},
									]
								: [message as never],
						),
				},
			});

			const events: string[] = [];
			const off = kernelOn(opened.kernel.ctx)("compaction:end", (event) => {
				events.push(`${event.reason}:${event.status}`);
			});

			// The host asks for it, the way a /compact command would.
			if (opened.compaction === undefined) throw new Error("the smoke opened a session without compaction");
			const compacted = await opened.compaction.manual();
			off();
			await opened.kernel.journaling.flush();
			expect(events).toEqual(["manual:completed"]);
			expect(compacted).toBe(true);

			// The summary is real notes, in the format the next reader needs.
			const summary = opened.runner.readContext()[0] as { role: string; summary?: string };
			expect(summary.role).toBe("compactionSummary");
			const notes = summary.summary ?? "";
			expect(notes).toContain("## Goal");
			expect(notes).toContain("## Progress");
			// The facts that mattered survived the cut.
			expect(notes.toUpperCase()).toContain("KUMQUAT-7");
			console.log(`smoke(compaction): notes=${JSON.stringify(notes.slice(0, 400))}`);

			// The compaction is in the journal, with the tail it kept.
			const entries = await storage.scanEntries({});
			const entry = entries.find((candidate) => candidate.type === "compaction")!;
			expect(entry.type).toBe("compaction");
			if (entry.type !== "compaction") throw new Error("unreachable");
			expect(entry.summary.length).toBeGreaterThan(50);
			expect(entry.retainedTail.length).toBeGreaterThan(0);
			expect(entry.tokensBefore).toBeGreaterThan(0);

			// And the session keeps working: a question about the summarized work is
			// answered from the notes. The deterministic half — the notes carry the
			// codename into the next request — is asserted above; reading them back is
			// a real model's job on a free endpoint, so it gets a second try before
			// the smoke calls it a failure.
			const ask = async (question: string): Promise<string> => {
				opened.kernel.inject(userMsg(question));
				await new Promise<void>((resolve) => {
					const timer = setInterval(() => {
						if (!opened.runner.running && opened.kernel.inboxDepth === 0) {
							clearInterval(timer);
							resolve();
						}
					}, 100);
					setTimeout(() => {
						clearInterval(timer);
						resolve();
					}, TIMEOUT_MS);
				});
				return opened.runner
					.getTranscript()
					.slice(-1)
					.flatMap((message) => {
						const content = (message as { content?: unknown }).content;
						if (!Array.isArray(content)) return [];
						return (content as { type?: string; text?: string }[])
							.filter((part) => part.type === "text")
							.map((part) => part.text ?? "");
					})
					.join(" ");
			};

			const pump = new RunPump(opened.kernel, opened.runner);
			pump.start();
			opened.kernel.config.update({ activeToolNames: [] });
			let recalled = await ask("What is the project codename? Answer with just the codename.");
			if (!recalled.toUpperCase().includes("KUMQUAT-7")) {
				console.warn(
					`smoke(compaction): first recall missed (${JSON.stringify(recalled.slice(0, 80))}); asking again`,
				);
				recalled = await ask(
					"The notes at the start of this session name the project codename. Answer with just that codename.",
				);
			}
			console.log(`smoke(compaction): recalled=${JSON.stringify(recalled.slice(0, 200))}`);
			expect(recalled.toUpperCase()).toContain("KUMQUAT-7");

			pump.stop();
			opened.stop();
			void opened.kernel.dispose();
		},
		TIMEOUT_MS,
	);
});
