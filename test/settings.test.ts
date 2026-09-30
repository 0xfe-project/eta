/**
 * Settings (S23).
 *
 * The rule the whole file exists for: settings are a *starting point*. A session applies them
 * when it is created, and changing them afterwards does not reach back into sessions that are
 * already running — the user has an explicit op for that (`sessions.modelSet`), and a second
 * invisible way for a session's model to change under them is not a feature.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/manager";
import { MemorySessionStore } from "../src/memory-store";
import { SettingsStore } from "../src/settings";

const roots: string[] = [];

async function scratch(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "eta-settings-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("the settings file", () => {
	it("is empty on a first run, and reads back what was written", async () => {
		const root = await scratch();
		const store = new SettingsStore({ path: join(root, "settings.json") });
		expect(await store.read()).toEqual({});
		await store.save({
			cwd: "/work/eta",
			persona: "Executor",
			model: "fake:fake-model",
			thinkingLevel: "high",
			keepRecentTokens: 12_000,
		});
		expect(await store.read()).toEqual({
			cwd: "/work/eta",
			persona: "Executor",
			model: "fake:fake-model",
			thinkingLevel: "high",
			keepRecentTokens: 12_000,
		});
		// A fresh store over the same path agrees: the file is the truth, not the cache.
		expect(await new SettingsStore({ path: join(root, "settings.json") }).read()).toMatchObject({ cwd: "/work/eta" });
	});

	it("merges a patch, keeps only its own keys, and clears on null", async () => {
		const root = await scratch();
		const path = join(root, "settings.json");
		const store = new SettingsStore({ path });
		await store.save({ cwd: "/work/eta", model: "fake:fake-model", thinkingLevel: "high" });
		// A patch is a patch: what it does not mention stays.
		const merged = await store.save({ persona: "Executor" });
		expect(merged).toMatchObject({
			cwd: "/work/eta",
			model: "fake:fake-model",
			thinkingLevel: "high",
			persona: "Executor",
		});
		// A key this file does not own is not written.
		await store.save({ providers: [{ id: "sneaky" }], theme: "dark" });
		expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("providers");
		expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("theme");
		// Nothing is invented from a nonsense value either.
		await store.save({ keepRecentTokens: -5, thinkingLevel: "galaxy" });
		const after = await store.read();
		expect(after.keepRecentTokens).toBeUndefined();
		expect(after.thinkingLevel).toBe("high");
		// And a null clears.
		await store.save({ cwd: null });
		expect((await store.read()).cwd).toBeUndefined();
	});

	it("writes atomically, so a reader never sees half a file", async () => {
		const root = await scratch();
		const path = join(root, "settings.json");
		const store = new SettingsStore({ path });
		await store.save({ cwd: "/a" });
		// The temp file is not left behind, and what is there parses.
		const raw = await readFile(path, "utf8");
		expect(() => JSON.parse(raw) as unknown).not.toThrow();
		const { readdir } = await import("node:fs/promises");
		expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("treats a broken file as no defaults rather than refusing to save", async () => {
		const root = await scratch();
		const path = join(root, "settings.json");
		await writeFile(path, "{ not json");
		const warnings: string[] = [];
		const store = new SettingsStore({ path, warn: (message) => warnings.push(message) });
		expect(await store.read()).toEqual({});
		expect(warnings[0]).toContain("not valid JSON");
		// Unlike the providers config, this one can be recovered: the whole point is that a
		// settings page keeps working.
		expect(await store.save({ cwd: "/work/eta" })).toEqual({ cwd: "/work/eta" });
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ cwd: "/work/eta" });
	});
});

describe("what a new session inherits", () => {
	const manager = (options: { settings?: () => Promise<Record<string, unknown>> } = {}) =>
		new SessionManager({
			store: new MemorySessionStore(),
			modelsFor: () => fakeModels([assistantMessage()]) as never,
			...(options.settings === undefined ? {} : { settings: options.settings as never }),
		});

	it("starts on the settings, and applies them to the kernel configuration too", async () => {
		const sessions = manager({
			settings: async () => ({
				cwd: "/work/eta",
				persona: "Executor",
				model: "fake:fake-model",
				thinkingLevel: "high",
				keepRecentTokens: 9_000,
			}),
		});
		const created = await sessions.create({});
		expect(created.meta).toMatchObject({ cwd: "/work/eta", persona: "Executor", model: "fake:fake-model" });
		expect(created.session.kernel.inspect().activePersonaNames).toContain("Executor");
		expect(created.session.config.thinkingLevel).toBe("high");
		expect(created.session.config.compaction.keepRecentTokens).toBe(9_000);
	});

	it("lets a caller override the settings for one session", async () => {
		const sessions = manager({ settings: async () => ({ cwd: "/from/settings", persona: "Executor" }) });
		const created = await sessions.create({ cwd: "/explicit", persona: "Other" });
		expect(created.meta.cwd).toBe("/explicit");
		expect(created.meta.persona).toBe("Other");
	});

	it("does not reach back into a session that is already running", async () => {
		let current: Record<string, unknown> = { cwd: "/first", thinkingLevel: "low" };
		const sessions = manager({ settings: async () => current });
		const first = await sessions.create({});
		expect(first.session.config.thinkingLevel).toBe("low");

		// The user changes their defaults.
		current = { cwd: "/second", thinkingLevel: "high" };
		// The session that exists keeps what it was created with...
		expect(first.session.config.thinkingLevel).toBe("low");
		expect(first.meta.cwd).toBe("/first");
		// ...and the next one is created on the new settings.
		const second = await sessions.create({});
		expect(second.session.config.thinkingLevel).toBe("high");
		expect(second.meta.cwd).toBe("/second");
		// And what the first session's journal says is still its own: a reopen does not adopt them.
		await sessions.close(first.meta.id);
		const reopened = await sessions.session(first.meta.id);
		expect(reopened?.session.config.thinkingLevel).toBe("low");
	});

	it("creates a session even when no settings are wired, on the process's own defaults", async () => {
		const sessions = manager();
		const created = await sessions.create({});
		expect(created.meta.cwd).toBe(process.cwd());
	});
});
