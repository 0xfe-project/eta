import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, createModels } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import type { HarnessEvent } from "../../src/harness/agent-harness.ts";
import { createNodeSqliteFactory, SQLITE_STORAGE_VERSION, SqliteStorage, sql } from "../../../eta-storage-sqlite/src/index.ts";
import { applyInitialSchema } from "../../../eta-storage-sqlite/src/sqlite/migrations.ts";
import { AskRegistry } from "../../src/harness/ask.ts";
import { StorageBackedSession } from "../../src/harness/session/session.ts";
import { EtaAgent } from "../../src/harness/agent.ts";
import { BtwManager } from "../../src/harness/btw.ts";
import type { EtaEmit } from "../../src/harness/events.ts";
import { GoalManager } from "../../src/harness/goal.ts";
import { LoopScheduler } from "../../src/harness/loops.ts";
import { TaskStore } from "../../src/harness/task-store.ts";
import { createStateTools, createTaskTools } from "../../src/harness/tools/index.ts";

const NOOP = () => {};

const CTX = BACKGROUND_CONTEXT;
const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function collector() {
	const events: { category: string; action: string; data: Record<string, unknown> }[] = [];
	const emit: EtaEmit = (category, action, data) => events.push({ category, action, data: data ?? {} });
	return {
		events,
		emit,
		of: (category: string, action?: string) =>
			events.filter((e) => e.category === category && (action === undefined || e.action === action)),
	};
}

describe("batteries emit on the shared sink", () => {
	it("every battery reports its category and actions", async () => {
		const c = collector();

		const goal = new GoalManager();
		goal.observe = c.emit;
		goal.set("ship it");
		goal.noteContinuation();
		goal.markAchieved();

		const scheduler = new LoopScheduler({ followUpFor: (spec) => `loop ${spec.def.id}`, observe: c.emit });
		const now = Date.now();
		scheduler.upsert({ def: { id: "tick", note: "ci", every: "1s" }, runCount: 0, createdAt: now - 5_000, nextDueAt: now - 1, paused: false });
		scheduler.upsert({ def: { id: "capped", note: "once", every: "1s", maxRuns: 1 }, runCount: 0, createdAt: now - 5_000, nextDueAt: now - 1, paused: false });
		scheduler.upsert({ def: { id: "stale", note: "old", every: "1s" }, runCount: 0, createdAt: now - 5_000, expiresAt: new Date(now - 1).toISOString(), paused: false });
		scheduler.pump(now);
		scheduler.upsert({ def: { id: "ev", note: "on turn" }, on: { type: "turn_end" }, runCount: 0, createdAt: now, paused: false });
		scheduler.event({ type: "turn_end" }, 99);

		const registry = new AskRegistry({ observe: c.emit });
		const ask = registry.ask({ questionId: "q1", question: "which?" });
		registry.answer("q1", { kind: "freeform", text: "b" });
		await ask;
		expect((await registry.ask({ questionId: "q2", question: "late?" }, { timeoutMs: 1 })).kind).toBe("none");
		const ac = new AbortController();
		const canceled = registry.ask({ questionId: "q3", question: "abort?" }, { signal: ac.signal });
		ac.abort();
		expect((await canceled).kind).toBe("none");

		const btw = new BtwManager(() => ({ messages: [] }), async () => {}, c.emit);
		const thread = btw.create("tangent");
		btw.answer(thread.id, "why?", "because");
		expect(btw.handoff(thread.id)).toContain("fold them in");
		expect(btw.save(thread.id, true)).toBe("queued");
		expect(await btw.flushQueued()).toBe(1);

		const store = new TaskStore();
		const taskTools = createTaskTools(store, c.emit);
		await taskTools[0]!.execute("c1", { content: "step one" }, NOOP, undefined, {} as never, CTX);
		await taskTools[3]!.execute("c2", { id: store.list()[0]!.id, status: "completed" }, NOOP, undefined, {} as never, CTX);

		const kv = new Map<string, string>();
		const stateTools = createStateTools(
			{
				get: async (k) => kv.get(k),
				set: async (k, v) => {
					if (v === null) kv.delete(k);
					else kv.set(k, v);
				},
				keys: async () => [...kv.keys()],
			},
			c.emit,
		);
		await stateTools[0]!.execute("s1", { key: "phase", value: "m5" }, NOOP, undefined, {} as never, CTX);

		expect(c.of("goal", "set").length).toBe(1);
		expect(c.of("goal", "continued").length).toBe(1);
		expect(c.of("goal", "achieved").length).toBe(1);
		expect(c.of("loop", "fired").map((e) => e.data.id)).toEqual(expect.arrayContaining(["tick", "capped"]));
		expect(c.of("loop", "paused").length).toBe(1);
		expect(c.of("loop", "expired").length).toBe(1);
		expect(c.of("loop", "suppressed").length).toBe(1);
		expect(c.of("ask_user", "asked").length).toBe(3);
		expect(c.of("ask_user", "answered").length).toBe(1);
		expect(c.of("ask_user", "expired").length).toBe(1);
		expect(c.of("ask_user", "canceled").length).toBe(1);
		expect([...c.of("btw").map((e) => e.action).sort()]).toEqual(["injected", "opened", "saved", "summarized"]);
		expect(c.of("todo", "add").length).toBe(1);
		expect(c.of("todo", "update").length).toBe(1);
		expect(c.of("state", "set").length).toBe(1);
	});
});

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("EtaAgent integrates batteries on the main bus", () => {
	it("one turn lights up eta events, native events, and the entry log", async () => {
		const dir = mkdtempSync(join(tmpdir(), "eta-agent-"));
		dirs.push(dir);
		const db = await createNodeSqliteFactory().open(join(dir, "m.db"));
		await applyInitialSchema(db);
		sql`INSERT INTO sessions
			(id, created_at, parent_session_id, storage_version, metadata, message_count, usage_payload, next_seq)
			VALUES (${"eta-main"}, ${Date.now()}, ${null}, ${SQLITE_STORAGE_VERSION}, ${null}, ${0}, ${JSON.stringify(EMPTY_USAGE)}, ${1})`.run(db);
		const storage = new SqliteStorage(db, { sessionId: "eta-main", now: () => Date.now() });

		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("TaskCreate", { content: "write the thing" })]),
			fauxAssistantMessage([fauxText("on it")]),
		]);
		const models = createModels();
		models.setProvider(faux.provider);
		const session = new StorageBackedSession({ id: "eta-main", createdAt: Date.now(), storageVersion: SQLITE_STORAGE_VERSION }, storage);

		const agent = await EtaAgent.create({ session, models, model: faux.getModel(), baseSystemPrompt: "you are eta", heartbeatMs: 0 }, CTX);
		const eta: HarnessEvent[] = [];
		const native: string[] = [];
		agent.events.on("eta", (event) => {
			eta.push(event);
		});
		agent.events.on("prompt_assembled", (event) => {
			native.push(`${event.type}:${event.systemPromptChars > 0}`);
		});
		agent.events.on("tool_end", (event) => {
			native.push(`tool_end:${event.toolName}`);
		});

		agent.goal.set("ship the thing");
		expect(agent.goal.current?.status).toBe("active");

		await agent.lane.prompt("get started", undefined, CTX);

		expect(eta.some((e) => e.type === "eta" && e.category === "goal" && e.action === "set")).toBe(true);
		expect(eta.some((e) => e.type === "eta" && e.category === "todo" && e.action === "add")).toBe(true);
		expect(eta.every((e) => e.type === "eta" && e.lane === "main")).toBe(true);
		expect(native).toContain("prompt_assembled:true");
		expect(native).toContain("tool_end:TaskCreate");
		expect(agent.tasks.list().length).toBe(1);

		const entries = await agent.lane.findEntries(undefined, CTX);
		expect(entries.some((e) => e.type === "goal")).toBe(true);

		await agent.close(CTX);
		void session.close(CTX);
	});
});

describe("D3 durable re-injection", () => {
	it("goal, tasks, and memory blocks survive compaction", async () => {
		const dir = mkdtempSync(join(tmpdir(), "eta-d3-"));
		dirs.push(dir);
		const db = await createNodeSqliteFactory().open(join(dir, "m.db"));
		await applyInitialSchema(db);
		sql`INSERT INTO sessions
			(id, created_at, parent_session_id, storage_version, metadata, message_count, usage_payload, next_seq)
			VALUES (${"eta-main"}, ${Date.now()}, ${null}, ${SQLITE_STORAGE_VERSION}, ${null}, ${0}, ${JSON.stringify(EMPTY_USAGE)}, ${1})`.run(db);
		const storage = new SqliteStorage(db, { sessionId: "eta-main", now: () => Date.now() });

		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage("first turn"),
			fauxAssistantMessage("compact summary of the old part"),
			fauxAssistantMessage("second turn"),
		]);
		const models = createModels();
		models.setProvider(faux.provider);
		const session = new StorageBackedSession({ id: "eta-main", createdAt: Date.now(), storageVersion: SQLITE_STORAGE_VERSION }, storage);
		const agent = await EtaAgent.create(
			{
				session,
				models,
				model: faux.getModel(),
				baseSystemPrompt: "you are eta",
				memorySource: () => "<memory>\n[untrusted notes collected earlier]\n## decision\n- use bun\n</memory>",
				heartbeatMs: 0,
			},
			CTX,
		);
		const prompts: string[] = [];
		agent.events.on("prompt_assembled", () => undefined);
		agent.harness.hooks.on(
			"transform_context",
			((event: { systemPrompt: string }) => {
				prompts.push(event.systemPrompt);
			}) as never,
		);

		agent.goal.set("finish the migration");
		agent.goal.gate = "delegated";
		await agent.lane.prompt("start", undefined, CTX);
		const store = agent.tasks;
		const created = store.create("run the tests", {});
		expect(created.task.id).toBe("t1");

		await agent.lane.compact(undefined, CTX);
		await agent.lane.prompt("continue", undefined, CTX);

		const last = prompts[prompts.length - 1]!;
		expect(last).toContain("finish the migration");
		expect(last).toContain("run the tests");
		expect(last).toContain("use bun");
		expect(last.indexOf("you are eta")).toBeLessThan(last.indexOf("use bun"));

		await agent.close(CTX);
		void session.close(CTX);
	});
});
