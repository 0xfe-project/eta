/**
 * Two sessions in one process.
 *
 * The server's whole job is that these do not mix: one process, the same working
 * directory if the user wants — and still two kernels, two journals, two tips, two
 * usage totals, two goals, two task ledgers, two buses. Sharing any one of them is
 * the kind of bug that looks like data loss to a user.
 *
 * Each session is its own cordis root precisely because it must be: cordis
 * dispatches a tree's events to the whole tree, and the harness subscribes to those
 * events to write the journal — a shared root would have one session's `message:end`
 * recorded into the other's log.
 */
import { kernelOn } from "@eta/core";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/manager";
import { MemorySessionStore } from "../src/memory-store";

const userMsg = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 });

const answering = () =>
	fakeModels([assistantMessage({ content: [{ type: "text", text: "an answer" }], stopReason: "stop" })]);

describe("two sessions in one process", () => {
	it("keeps journal, tip, usage, goal and tasks apart", async () => {
		const store = new MemorySessionStore();
		const sessions = new SessionManager({ store, modelsFor: () => answering() as never });
		const first = await sessions.create({ cwd: "/work/same-directory" });
		const second = await sessions.create({ cwd: "/work/same-directory" });

		// Two scopes, not two branches of one.
		expect(first.session.kernel.ctx).not.toBe(second.session.kernel.ctx);

		// A goal on one is not a goal on the other.
		first.session.kernel.goal.set("finish the first session's work");
		expect(first.session.kernel.goal.current?.objective).toContain("first session");
		expect(second.session.kernel.goal.current).toBeUndefined();
		first.session.kernel.goal.clear();

		// A task ledger on one is not the ledger of the other.
		first.session.kernel.tasks.create("only in the first");
		expect(first.session.kernel.tasks.list()).toHaveLength(1);
		expect(second.session.kernel.tasks.list()).toHaveLength(0);

		// A message and a usage row land in the first journal, not the second.
		first.session.log.recordMessage(userMsg("first session's message"));
		// (The goal above was journalled too: `set` and `clear` are entries.)
		first.session.log.recordUsage({
			id: "u1",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			adjustment: false,
		});
		await first.session.journaling.flush();

		const firstStorage = (await store.open(first.meta.id))!.storage;
		const secondStorage = (await store.open(second.meta.id))!.storage;
		expect(await firstStorage.scanEntries({})).toHaveLength(3);
		expect(await secondStorage.scanEntries({})).toEqual([]);
		expect((await firstStorage.getStats()).usage.totalTokens).toBe(15);
		expect((await secondStorage.getStats()).usage.totalTokens).toBe(0);

		// Each journal's tip is its own: writing to one does not move the other's.
		const firstTip = first.session.log.graph.tipId();
		const secondTip = second.session.log.graph.tipId();
		expect(firstTip).not.toBe(secondTip);
		second.session.log.recordMessage(userMsg("second session's message"));
		await second.session.journaling.flush();
		expect(first.session.log.graph.tipId()).toBe(firstTip);
		expect(second.session.log.graph.tipId()).not.toBe(secondTip);

		await sessions.closeAll();
	});

	it("does not leak one session's bus events into the other", async () => {
		const sessions = new SessionManager({
			store: new MemorySessionStore(),
			modelsFor: () => answering() as never,
		});
		const first = await sessions.create({ cwd: "/work" });
		const second = await sessions.create({ cwd: "/work" });

		const seenBySecond: string[] = [];
		kernelOn(second.session.kernel.ctx)("task:created", (event) => {
			seenBySecond.push(event.task.id);
		});
		first.session.kernel.tasks.create("a task in the first session");

		// The event happened on the first session's bus; the second never hears it.
		expect(seenBySecond).toEqual([]);
		expect(second.session.kernel.tasks.list()).toEqual([]);
		await sessions.closeAll();
	});

	it("closing one session leaves the other usable", async () => {
		const sessions = new SessionManager({
			store: new MemorySessionStore(),
			modelsFor: () => answering() as never,
		});
		const first = await sessions.create({ cwd: "/work" });
		const second = await sessions.create({ cwd: "/work" });
		second.session.kernel.goal.set("the second session keeps working");

		await sessions.close(first.meta.id);
		// The second session's kernel, goal and ledger are untouched by the close.
		expect(second.session.kernel.goal.current?.objective).toBe("the second session keeps working");
		second.session.kernel.tasks.create("still able to work");
		expect(second.session.kernel.tasks.list()).toHaveLength(1);
		// And the closed one is genuinely gone from the open set (asking for it again
		// would buy a fresh assembly over its journal, which the manager does offer —
		// `close`, not the id, is what frees the slot).
		expect(await sessions.close(first.meta.id)).toBe(false);
		expect(sessions.openSessions().map((managed) => managed.meta.id)).toEqual([second.meta.id]);
		await sessions.closeAll();
	});
});
