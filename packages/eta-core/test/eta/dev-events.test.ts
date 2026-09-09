import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, createModels } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { StorageBackedSession } from "../../src/harness/session/session.ts";
import { createNodeSqliteFactory, SQLITE_STORAGE_VERSION, SqliteStorage, sql } from "../../../eta-storage-sqlite/src/index.ts";
import { applyInitialSchema } from "../../../eta-storage-sqlite/src/sqlite/migrations.ts";
import { AskRegistry } from "../../src/eta/ask.ts";
import { BtwManager } from "../../src/eta/btw.ts";
import { DevEventBus, MemoryDevEventSink } from "../../src/eta/dev-events.ts";
import { createDevBridge } from "../../src/eta/dev-bridge.ts";
import { createStateTools, createTaskTools } from "../../src/eta/tools.ts";
import { GoalManager } from "../../src/eta/goal.ts";
import { LoopScheduler } from "../../src/eta/loops.ts";
import { TaskStore } from "../../src/eta/task-store.ts";
import type { BatteryTool } from "../../src/eta/tools.ts";

const CTX = BACKGROUND_CONTEXT;

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("dev event bus + batteries", () => {
	it("every battery emits its category and actions", async () => {
		const bus = new DevEventBus("main");
		const sink = new MemoryDevEventSink(bus);
		const emit = bus.emit;

		const goal = new GoalManager();
		goal.dev = emit;
		goal.set("ship it");
		goal.noteContinuation();
		goal.markAchieved();

		const scheduler = new LoopScheduler({
			followUpFor: (spec) => `loop ${spec.def.id}`,
			dev: (category, action, data) => emit(category, action, data),
		});
		const now = Date.now();
		scheduler.upsert({ def: { id: "tick", note: "ci", every: "1s" }, runCount: 0, createdAt: now - 5_000, nextDueAt: now - 1, paused: false });
		scheduler.upsert({ def: { id: "capped", note: "once", every: "1s", maxRuns: 1 }, runCount: 0, createdAt: now - 5_000, nextDueAt: now - 1, paused: false });
		scheduler.upsert({ def: { id: "stale", note: "old", every: "1s" }, runCount: 0, createdAt: now - 5_000, expiresAt: new Date(now - 1).toISOString(), paused: false });
		scheduler.pump(now);

		const registry = new AskRegistry({ dev: emit });
		const ask = registry.ask({ questionId: "q1", question: "which?" });
		registry.answer("q1", { kind: "freeform", text: "b" });
		await ask;
		const expired = registry.ask({ questionId: "q2", question: "late?" }, { timeoutMs: 1 });
		expect((await expired).kind).toBe("none");
		const ac = new AbortController();
		const canceled = registry.ask({ questionId: "q3", question: "abort?" }, { signal: ac.signal });
		ac.abort();
		expect((await canceled).kind).toBe("none");

		const btw = new BtwManager(() => ({ messages: [] }), async () => {}, emit);
		const thread = btw.create("tangent");
		btw.answer(thread.id, "why?", "because");
		expect(btw.handoff(thread.id)).toContain("fold them in");
		expect(btw.save(thread.id, true)).toBe("queued");
		expect(await btw.flushQueued()).toBe(1);

		const store = new TaskStore();
		const taskTools = createTaskTools(store, undefined, emit);
		await taskTools[0]!.execute("c1", { content: "step one" }, undefined, undefined, {} as never, CTX);
		const update = taskTools[3]!;
		await update.execute("c2", { id: store.list()[0]!.id, status: "completed" }, undefined, undefined, {} as never, CTX);

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
			emit,
		);
		await stateTools[0]!.execute("s1", { key: "phase", value: "m5" }, undefined, undefined, {} as never, CTX);

		expect(sink.of("goal", "set").length).toBe(1);
		expect(sink.of("goal", "continued").length).toBe(1);
		expect(sink.of("goal", "achieved").length).toBe(1);
		expect(sink.of("loop", "fired").map((e) => e.data.id)).toEqual(expect.arrayContaining(["tick", "capped"]));
		expect(sink.of("loop", "paused").length).toBe(1);
		expect(sink.of("loop", "expired").length).toBe(1);
		scheduler.event({ type: "turn_end" }, 99);
		expect(sink.of("loop", "suppressed").length).toBe(0); // no interval due check for event loops: only due specs suppress
		expect(sink.of("ask_user", "asked").length).toBe(3);
		expect(sink.of("ask_user", "answered").length).toBe(1);
		expect(sink.of("ask_user", "expired").length).toBe(1);
		expect(sink.of("ask_user", "canceled").length).toBe(1);
		expect([...sink.of("btw").map((e) => e.action).sort()]).toEqual(["injected", "opened", "saved", "summarized"]);
		expect(sink.of("todo", "add").length).toBe(1);
		expect(sink.of("todo", "update").length).toBe(1);
		expect(sink.of("state", "set").length).toBe(1);
		expect(sink.events.every((e) => e.agentId === "main")).toBe(true);
		expect(sink.events.map((e) => e.seq)).toEqual([...sink.events.map((e) => e.seq)].sort((a, b) => a - b));
	});

	it("trace-depth suppression fires for event loops over the cap", () => {
		const bus = new DevEventBus("main");
		const sink = new MemoryDevEventSink(bus);
		const scheduler = new LoopScheduler({
			followUpFor: (spec) => `loop ${spec.def.id}`,
			dev: (c, a, d) => bus.emit(c, a, d),
		});
		scheduler.upsert({ def: { id: "ev", note: "on turn" }, on: { type: "turn_end" }, runCount: 0, createdAt: Date.now(), paused: false });
		scheduler.event({ type: "turn_end" }, 99);
		expect(sink.of("loop", "suppressed").length).toBe(1);
		expect(sink.of("loop", "fired").length).toBe(0);
	});
});

describe("dev bridge over a harness turn", () => {
	const dirs: string[] = [];
	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	it("mirrors lifecycle/turn/prompt/tool/usage/retry/compaction", async () => {
		const dir = mkdtempSync(join(tmpdir(), "eta-dev-"));
		dirs.push(dir);
		const db = await createNodeSqliteFactory().open(join(dir, "m.db"));
		await applyInitialSchema(db);
		sql`INSERT INTO sessions
			(id, created_at, parent_session_id, storage_version, metadata, message_count, usage_payload, next_seq)
			VALUES (${("eta-main")}, ${Date.now()}, ${null}, ${SQLITE_STORAGE_VERSION}, ${null}, ${0}, ${JSON.stringify(EMPTY_USAGE)}, ${1})`.run(db);
		const storage = new SqliteStorage(db, { sessionId: "eta-main", now: () => Date.now() });

		const faux = fauxProvider();
		const boom = fauxAssistantMessage([fauxText("x")], { stopReason: "error", errorMessage: "503 upstream overloaded" });
		faux.setResponses([
			boom,
			fauxAssistantMessage([fauxToolCall("echo", { text: "hi" })]),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("summary of the conversation"),
		]);
		const models = createModels();
		models.setProvider(faux.provider);
		const session = new StorageBackedSession({ id: "eta-main", createdAt: Date.now(), storageVersion: SQLITE_STORAGE_VERSION }, storage);
		const echo: BatteryTool = {
			name: "echo",
			label: "echo",
			description: "echo back",
			parameters: { type: "object", properties: { text: { type: "string" } } } as never,
			async execute(_id, params) {
				return { content: [{ type: "text" as const, text: String(params.text) }], details: undefined };
			},
		};
		const { harness } = await AgentHarness.create(
			{ session, models, model: faux.getModel(), activeToolNames: ["echo"], tools: [echo] as never },
			CTX,
		);
		const bus = new DevEventBus("main");
		const sink = new MemoryDevEventSink(bus);
		const bridge = createDevBridge(harness, bus);

		const lane = await harness.lane("main", CTX);
		await lane.prompt("say hi", undefined, CTX);
		await lane.compact(undefined, CTX);

		expect(sink.of("lifecycle", "attach").length).toBe(1);
		expect(sink.of("turn", "start").length).toBeGreaterThanOrEqual(1);
		expect(sink.of("turn", "end").length).toBeGreaterThanOrEqual(1);
		expect(sink.of("prompt", "assembled").length).toBeGreaterThanOrEqual(1);
		expect(sink.of("usage", "response").length).toBeGreaterThanOrEqual(1);
		expect(sink.of("tool", "start").some((e) => e.data.toolName === "echo")).toBe(true);
		expect(sink.of("tool", "end").some((e) => e.data.toolName === "echo" && e.data.isError === false)).toBe(true);
		expect(sink.of("retry", "request").length).toBeGreaterThanOrEqual(1);
		expect(sink.of("compaction", "start").length).toBe(1);
		bridge.detach();
		expect(sink.of("lifecycle", "detach").length).toBe(1);
		void harness.close(CTX);
		void session.close(CTX);
	});
});
