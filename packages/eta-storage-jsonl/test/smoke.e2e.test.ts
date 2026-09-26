/**
 * The smoke scenario against a real file (REFACTOR.md §2.2 + §K5).
 *
 * Same env gate as the core smoke test, one level down: a real provider's
 * stream, journaled through the real JSONL journal, then reopened from disk.
 * What it adds over the memory variant is the part only a file can prove —
 * fsync'd appends are readable by a fresh handle, and the transcript a restart
 * rebuilds is the one the model answered from.
 *
 *   ETA_SMOKE_CONFIG=~/.eta/config.json bun run test test/smoke.e2e.test.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realModels, runSmokeScenario, selectProvider } from "@eta/core/testing";
import { afterAll, describe, expect, it } from "vitest";
import { JsonlStorage } from "../src/index";

const configPath = process.env.ETA_SMOKE_CONFIG;
const modelSelector = process.env.ETA_SMOKE_MODEL;
const TIMEOUT_MS = Number(process.env.ETA_SMOKE_TIMEOUT_MS ?? 180_000);
let dir = "";

afterAll(async () => {
	if (dir.length > 0) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(configPath === undefined)("real model smoke on disk", () => {
	it(
		"writes a real session to a journal file, and reopens it",
		async () => {
			const selected = await selectProvider(configPath!, modelSelector);
			dir = await mkdtemp(join(tmpdir(), "eta-smoke-"));
			const path = join(dir, "session.jsonl");
			const storage = await JsonlStorage.open(path);

			const report = await runSmokeScenario({
				models: realModels(selected.spec),
				provider: selected.spec.id,
				modelId: selected.modelId,
				storage,
				timeoutMs: TIMEOUT_MS,
			});
			// The model decides how to phrase the note; the word has to be in it.
			expect(report.notes.join(" ").toLowerCase()).toContain("kumquat");
			expect(report.configRestored).toBe(true);
			expect(report.entries).toBeGreaterThanOrEqual(4);
			await storage.close();

			// A fresh handle over the same file sees the same session, and the
			// journal is intact (nothing to repair).
			const reopened = await JsonlStorage.open(path);
			expect(await reopened.repairTornTail()).toEqual({
				droppedBytes: 0,
				droppedRecords: 0,
				trailingOnly: true,
			});
			const entries = await reopened.scanEntries({ order: "asc" });
			expect(entries[0]!.parentId).toBeNull();
			for (let index = 1; index < entries.length; index += 1) {
				expect(entries[index]!.parentId).toBe(entries[index - 1]!.id);
			}
			const stats = await reopened.getStats();
			expect(stats.usage.totalTokens).toBeGreaterThan(0);
			console.log(`smoke(file): path=${path} entries=${entries.length} totalTokens=${stats.usage.totalTokens}`);
			await reopened.close();
		},
		TIMEOUT_MS,
	);
});
