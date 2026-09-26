/**
 * Smoke test against a real provider (REFACTOR.md §2.2).
 *
 * Skipped unless a configuration file is named, so the normal suite stays
 * offline and deterministic:
 *
 *   ETA_SMOKE_CONFIG=~/.eta/config.json bun run test test/smoke.e2e.test.ts
 *   ETA_SMOKE_MODEL=provider:model   (defaults to the file's own defaultModel)
 *
 * Nothing about the endpoint is hardcoded: provider, base URL, key, and model
 * all come from that file (or from the environment). What it proves is what the
 * scripted fakes cannot — that pi-ai's real stream, real usage numbers, and a
 * real model satisfy the contract the runner expects, and that a real
 * transcript survives a reload.
 */
import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../src/index";
import { selectProvider } from "../src/testing/eta-config";
import { realModels } from "../src/testing/real-models";
import { runSmokeScenario } from "../src/testing/smoke-scenario";

const configPath = process.env.ETA_SMOKE_CONFIG;
const modelSelector = process.env.ETA_SMOKE_MODEL;
const TIMEOUT_MS = Number(process.env.ETA_SMOKE_TIMEOUT_MS ?? 180_000);

describe.skipIf(configPath === undefined)("real model smoke", () => {
	it(
		"streams a turn, calls a tool, journals it, and answers from a reloaded transcript",
		async () => {
			const selected = await selectProvider(configPath!, modelSelector);
			const models = realModels(selected.spec);
			expect(models.getModel(selected.spec.id, selected.modelId)).toBeDefined();

			const report = await runSmokeScenario({
				models,
				provider: selected.spec.id,
				modelId: selected.modelId,
				storage: new MemoryStorage(),
				timeoutMs: TIMEOUT_MS,
			});

			// What a real provider must produce: a completed run, real deltas, real
			// tokens, a tool call with the right argument, and a journal.
			expect(report.events).toContain("run-end:completed");
			expect(report.events).toContain("message:update");
			expect(report.events).toContain("tool:end");
			expect(report.events).toContain("entry:added");
			expect(report.events).toContain("usage:recorded");
			expect(report.streamedChars).toBeGreaterThan(0);
			expect(report.usage.length).toBeGreaterThan(0);
			expect(report.usage.every((row) => row.totalTokens > 0)).toBe(true);
			expect(report.stats.input).toBeGreaterThan(0);
			expect(report.stats.totalTokens).toBeGreaterThan(0);
			// The model decides how to phrase the note; the word has to be in it.
			expect(report.notes.join(" ").toLowerCase()).toContain("kumquat");
			expect(report.firstAnswer.length).toBeGreaterThan(0);
			// user, assistant(tool call), tool result, assistant(reply)
			expect(report.entries).toBeGreaterThanOrEqual(4);
			expect(report.stats.messageCount).toBeGreaterThanOrEqual(4);
			// The reloaded transcript is what the second answer came from, and the
			// configuration the first session left came back with it.
			expect(report.recalled.toLowerCase()).toContain("kumquat");
			expect(report.configRestored).toBe(true);
		},
		TIMEOUT_MS,
	);
});
