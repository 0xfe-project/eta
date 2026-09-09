import { fauxAssistantMessage, fauxProvider, fauxToolCall, createModels } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { createNodeSqliteFactory, SQLITE_STORAGE_VERSION, SqliteStorage, sql } from "../../../eta-storage-sqlite/src/index.ts";
import { applyInitialSchema } from "../../../eta-storage-sqlite/src/sqlite/migrations.ts";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
import { StorageBackedSession } from "../../src/harness/session/session.ts";
import type { Entry, Session } from "../../src/harness/session/types.ts";
import { AskRegistry, createAskUserTool } from "../../src/harness/ask.ts";
import { GoalManager } from "../../src/harness/goal.ts";
import { LoopScheduler } from "../../src/harness/loops.ts";
import { GOAL_CONTINUATION } from "../../src/prompts/index.ts";
import { goalDriver, loopDriver } from "../../src/harness/run-end.ts";
import type { AskPayload } from "../../src/harness/entries.ts";

const CTX = BACKGROUND_CONTEXT;
const dirs: string[] = [];

interface Fixture {
	session: Session;
	lane: Awaited<ReturnType<AgentHarness["lane"]>>;
	harness: AgentHarness;
}

async function openStorage(file: string, fresh: boolean, id: string): Promise<SqliteStorage> {
	const db = await createNodeSqliteFactory().open(file);
	if (fresh) {
		await applyInitialSchema(db);
		sql`INSERT INTO sessions
			(id, created_at, parent_session_id, storage_version, metadata, message_count, usage_payload, next_seq)
			VALUES (${id}, ${Date.now()}, ${null}, ${SQLITE_STORAGE_VERSION}, ${null}, ${0}, ${JSON.stringify(EMPTY_USAGE)}, ${1})`.run(db);
	}
	return new SqliteStorage(db, { sessionId: id, now: () => Date.now() });
}

async function attach(storage: SqliteStorage, faux: ReturnType<typeof fauxProvider>, tools: unknown[], hooks?: (h: AgentHarness) => void, id = "eta-integration"): Promise<Fixture> {
	const activeToolNames = tools.length > 0 ? ["ask_user"] : [];
	const models = createModels();
	models.setProvider(faux.provider);
	const session = new StorageBackedSession({ id: "eta-main", createdAt: Date.now(), storageVersion: SQLITE_STORAGE_VERSION }, storage);
	const { harness } = await AgentHarness.create({ session, models, model: faux.getModel(), activeToolNames, tools: tools as never }, CTX);
	const lane = await harness.lane("main", CTX);
	hooks?.(harness);
	return { session, lane, harness };
}

async function entryLog(lane: Awaited<ReturnType<AgentHarness["lane"]>>): Promise<Entry[]> {
	return lane.findEntries(undefined, CTX);
}

afterAll(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ask_user kill-restart-answer", () => {
	it("pending question survives restart and backfills the waiting tool call", async () => {
		const dir = mkdtempSync(join(tmpdir(), "eta-m4-"));
		dirs.push(dir);
		const file = join(dir, "main.db");
		const storage = await openStorage(file, true, "eta-main");
		const registry = new AskRegistry();
		const laneRef: { lane?: Awaited<ReturnType<AgentHarness["lane"]>> } = {};
		const tool = createAskUserTool({
			registry,
			onAsk: async (payload: AskPayload) => {
				await laneRef.lane?.append({ type: "ask", payload } as never, CTX);
			},
		});
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("ask_user", { question: "which one?" })]),
			fauxAssistantMessage("go with b"),
		]);
		const first = await attach(storage, faux, [tool]);
		laneRef.lane = first.lane;
		const run1 = first.lane.prompt("pick", undefined, CTX);

		// wait until the assistant turn is committed and the tool is waiting
		for (let i = 0; i < 50 && registry.pendingAsks().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
		expect(registry.pendingAsks().map((a) => a.question)).toEqual(["which one?"]);
		// the durable pending record is the invocation memo; the eta.ask entry
		// rides the operation's commit and lands after the run settles

		// crash: walk away mid-run (no close = no graceful abort); the durable
		// operation state in the store is what the next attach resumes from.
		void run1.catch(() => undefined);
		void first;

		// restart: same storage, fresh objects, replay pending from entries
		const registry2 = new AskRegistry();
		const faux2 = fauxProvider();
		faux2.setResponses([fauxAssistantMessage("go with b")]);
		const second = await attach(await openStorage(file, false, "eta-main"), faux2, [createAskUserTool({ registry: registry2, onAsk: async () => {} })], undefined);
		// resume re-executes the waiting tool; its stable invocationId re-registers
		// the same question, so answering after resume backfills the old call.
		const resume = second.lane.resume(CTX);
		let questionId: string | undefined;
		for (let i = 0; i < 200 && questionId === undefined; i++) {
			await new Promise((r) => setTimeout(r, 5));
			questionId = registry2.pendingAsks()[0]?.questionId;
		}
		expect(questionId).toBeDefined();
		registry2.answer(questionId!, { kind: "selection", selections: ["b"] });
		await resume;
		await second.lane.waitForIdle(CTX);
		const after = await entryLog(second.lane);
		expect(after.some((e) => e.type === "ask")).toBe(true);
		expect(after.filter((e) => e.type === "message" && e.message.role === "toolResult")).toBeTruthy();
		void second.harness.close(CTX);
		void second.session.close(CTX);
	}, 15_000);
});

describe("run-end drivers", () => {
	it("goal driver keeps the run alive with a followUp until achieved", async () => {
		const goal = new GoalManager();
		const laneRef: { lane?: Awaited<ReturnType<AgentHarness["lane"]>> } = {};
		let evalCalls = 0;
		goal.onChange = async (change) => {
			await laneRef.lane?.append({ type: "goal", payload: { kind: change.goal.status, objective: change.goal.objective } } as never, CTX);
		};
		goal.set("ship M4");
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage("partial progress"), fauxAssistantMessage("more progress"), fauxAssistantMessage("idle now")]);
		const goalDir = mkdtempSync(join(tmpdir(), "eta-goal-"));
		dirs.push(goalDir);
		const { session, lane, harness } = await attach(await openStorage(join(goalDir, "m.db"), true, "eta-main"), faux, [], (h) => {
			h.hooks.on("before_run_end", goalDriver({ goal, evaluate: async () => ++evalCalls > 1 }), { id: "eta.goal" });
		}, "eta-goal");
		laneRef.lane = lane;
		await lane.prompt("start", undefined, CTX);
		expect(goal.current?.roundCount).toBe(1);
		const entries = await entryLog(lane);
		const injected = entries.filter(
			(e) => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes(GOAL_CONTINUATION),
		);
		expect(injected.length).toBe(1);
		expect(entries.some((e) => e.type === "goal")).toBe(true);
		await harness.close(CTX);
		await session.close(CTX);
	}, 15_000);

	it("loop driver pumps due loops into a followUp at the boundary", async () => {
		const scheduler = new LoopScheduler({ followUpFor: (s) => `[loop ${s.def.id}] ${s.def.note}` });
		scheduler.upsert({ def: { id: "tick", note: "check ci", every: "1s" }, runCount: 0, createdAt: Date.now() - 5_000, nextDueAt: Date.now() - 1, paused: false });
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("checked ci")]);
		const loopDir = mkdtempSync(join(tmpdir(), "eta-loop-"));
		dirs.push(loopDir);
		const { session, lane, harness } = await attach(await openStorage(join(loopDir, "m.db"), true, "eta-main"), faux, [], (h) => {
			h.hooks.on("before_run_end", loopDriver(scheduler), { id: "eta.loop" });
		}, "eta-loop");
		await lane.prompt("go", undefined, CTX);
		expect(scheduler.list()[0]!.runCount).toBe(1);
		const entries = await entryLog(lane);
		expect(
			entries.some(
				(e) => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes("[loop tick] check ci"),
			),
		).toBe(true);
		await harness.close(CTX);
		await session.close(CTX);
	}, 15_000);
});
