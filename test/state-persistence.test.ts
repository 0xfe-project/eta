/**
 * Session state that outlives the process (REFACTOR.md §K5, §2.3).
 *
 * The journal already carried history — messages, usage, compactions, the goal,
 * the branch tip. What it did not carry was the two things a session *is*: the
 * configuration it was left on, and the task ledger it was working through.
 * Both are written whole, last write wins, so a reload cannot read a
 * half-applied state.
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACTION_SETTINGS,
	DEFAULT_RETRY_POLICY,
	Kernel,
	type KernelConfig,
	MemoryStorage,
	SESSION_CONFIG,
	SessionLog,
	type StoredTask,
	TASKS_STATE,
} from "../src/index";

const userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

async function session() {
	const storage = new MemoryStorage();
	const log = SessionLog.create(storage);
	const kernel = Kernel.create({
		config: {
			model: { provider: "p", modelId: "m" },
			activeToolNames: ["read"],
			thinkingLevel: "low",
		},
		journal: log,
	});
	return { storage, log, kernel, dispose: () => void kernel.dispose() };
}

const readConfig = async (storage: MemoryStorage): Promise<KernelConfig | undefined> =>
	(await storage.getValue(SESSION_CONFIG))?.value;

const readTasks = async (storage: MemoryStorage): Promise<StoredTask[] | undefined> =>
	(await storage.getValue(TASKS_STATE))?.value;

describe("configuration is durable", () => {
	it("writes the whole configuration when it changes", async () => {
		const { storage, kernel, dispose } = await session();
		expect(await readConfig(storage)).toBeUndefined();

		kernel.config.update({ thinkingLevel: "high", activeToolNames: ["read", "write"] });
		await kernel.journaling.flush();

		const written = await readConfig(storage);
		expect(written?.model).toEqual({ provider: "p", modelId: "m" });
		expect(written?.thinkingLevel).toBe("high");
		expect(written?.activeToolNames).toEqual(["read", "write"]);
		// The settings a session cannot be rebuilt without ride along.
		expect(written?.retryPolicy).toEqual(DEFAULT_RETRY_POLICY);
		expect(written?.compaction).toEqual(DEFAULT_COMPACTION_SETTINGS);
		dispose();
	});

	it("keeps the newest configuration, and a reload reads it back", async () => {
		const { storage, kernel, dispose } = await session();
		kernel.config.update({ thinkingLevel: "high" });
		kernel.config.update({ thinkingLevel: "max" });
		kernel.config.setModel("other", "model-2");
		await kernel.journaling.flush();

		const restored = await readConfig(storage);
		expect(restored?.thinkingLevel).toBe("max");
		expect(restored?.model).toEqual({ provider: "other", modelId: "model-2" });
		// And a fresh kernel adopts it, which is what the assembly path will do.
		const reopened = Kernel.create({ journal: await SessionLog.load(storage) });
		reopened.config.update(restored!);
		expect(reopened.config.read("model")).toEqual({ provider: "other", modelId: "model-2" });
		expect(reopened.config.read("thinkingLevel")).toBe("max");
		void reopened.dispose();
		dispose();
	});

	it("a rejected update writes nothing", async () => {
		const { storage, kernel, dispose } = await session();
		expect(() =>
			kernel.config.update({ compaction: { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: -1 } }),
		).toThrow();
		await kernel.journaling.flush();
		expect(await readConfig(storage)).toBeUndefined();
		dispose();
	});
});

describe("the task ledger is durable", () => {
	it("writes the whole list on every change, under eta-agent's namespace", async () => {
		const { storage, kernel, dispose } = await session();
		expect(await readTasks(storage)).toBeUndefined();

		kernel.tasks.create("first task");
		await kernel.journaling.flush();
		expect((await readTasks(storage))?.map((task) => task.content)).toEqual(["first task"]);

		kernel.tasks.update("t1", { status: "in_progress", priority: "high" });
		await kernel.journaling.flush();
		const inProgress = await readTasks(storage);
		expect(inProgress?.[0]).toMatchObject({ id: "t1", status: "in_progress", priority: "high" });

		kernel.tasks.create("second task", { deps: ["t1"] });
		await kernel.journaling.flush();
		const two = await readTasks(storage);
		expect(two?.map((task) => task.id)).toEqual(["t1", "t2"]);
		expect(two?.[1]?.dependsOn).toEqual(["t1"]);
		// The namespace is the one a real eta-agent journal used.
		expect(TASKS_STATE.namespace).toBe("eta.tasks.state");
		dispose();
	});

	it("a reload restores the ledger, ids included", async () => {
		const { storage, kernel, dispose } = await session();
		kernel.tasks.create("done thing");
		kernel.tasks.create("open thing", { deps: ["t1"], priority: "medium" });
		kernel.tasks.update("t1", { status: "completed" });
		kernel.tasks.remove("t2");
		kernel.tasks.create("after the removal");
		await kernel.journaling.flush();
		const before = kernel.tasks.list();
		expect(before.map((task) => task.id)).toEqual(["t1", "t3"]);

		// A fresh kernel over the same journal gets the same ledger back.
		const reopened = Kernel.create({ journal: await SessionLog.load(storage) });
		const restored = reopened.tasks.restore(await readTasks(storage));
		expect(restored).toEqual({ kept: 2, dropped: [] });
		expect(reopened.tasks.list()).toEqual(before);
		// Ids are never reused: the next auto-id continues past the highest one.
		expect(reopened.tasks.create("next").task.id).toBe("t4");
		void reopened.dispose();
		dispose();
	});

	it("a malformed row is dropped on restore rather than poisoning the ledger", async () => {
		const { storage, kernel, dispose } = await session();
		kernel.tasks.create("good");
		await kernel.journaling.flush();
		const raw = (await readTasks(storage))!;
		const poisoned = [...raw, { id: "t9", content: 42, status: "pending" }];
		await storage.commit([
			{ kind: "value", op: "set", namespace: TASKS_STATE.namespace, key: TASKS_STATE.key, value: poisoned },
		]);

		const reopened = Kernel.create({ journal: await SessionLog.load(storage) });
		const restored = reopened.tasks.restore(await readTasks(storage));
		expect(restored).toEqual({ kept: 1, dropped: ["t9"] });
		expect(reopened.tasks.list().map((task) => task.content)).toEqual(["good"]);
		void reopened.dispose();
		dispose();
	});
});

describe("the writes stay out of the way", () => {
	it("a session with no journal keeps nothing, and does not fail", async () => {
		const kernel = Kernel.create({ config: { model: { provider: "p", modelId: "m" } } });
		kernel.config.update({ thinkingLevel: "high" });
		kernel.tasks.create("nowhere to go");
		await kernel.journaling.flush();
		expect(kernel.journaling.entries()).toEqual([]);
		void kernel.dispose();
	});

	it("state writes do not disturb the branch tip", async () => {
		const { storage, kernel, log, dispose } = await session();
		log.recordMessage(userMsg("a message"));
		await log.commit();
		const tip = log.graph.tipId();
		kernel.config.update({ thinkingLevel: "high" });
		kernel.tasks.create("something");
		await kernel.journaling.flush();
		const reloaded = await SessionLog.load(storage);
		expect(reloaded.graph.tipId()).toBe(tip);
		dispose();
	});

	it("a config write lands after the entries queued before it", async () => {
		const { storage, kernel, log, dispose } = await session();
		log.recordMessage(userMsg("before the change"));
		await log.commit();
		kernel.config.update({ thinkingLevel: "high" });
		await kernel.journaling.flush();

		const entries = await storage.scanEntries({ order: "asc" });
		const configRow = await storage.getValue(SESSION_CONFIG);
		expect(configRow!.seq).toBeGreaterThan(entries.at(-1)!.seq);
		dispose();
	});
});
