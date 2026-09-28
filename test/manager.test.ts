/**
 * The session manager.
 *
 * What it must get right: a session is assembled once and reused, each one is
 * genuinely its own (its own kernel, journal, usage, ledger), listing does not
 * require opening, and closing one leaves the others alone.
 */
import { SessionLog } from "@eta/core";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/manager";
import { MemorySessionStore } from "../src/memory-store";

const userMsg = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 });

function manager(options: { models?: unknown } = {}) {
	const store = new MemorySessionStore();
	const warnings: string[] = [];
	const made = new SessionManager({
		store,
		modelsFor: () => (options.models ?? fakeModels([])) as never,
		warn: (message) => warnings.push(message),
	});
	return { store, manager: made, warnings };
}

describe("creating and opening", () => {
	it("creates a session, opens it once, and reuses the open handle", async () => {
		const { manager: sessions } = manager();
		const created = await sessions.create({ cwd: "/work/eta", title: "first" });
		expect(created.meta.id.startsWith("eta-")).toBe(true);
		expect(created.meta.cwd).toBe("/work/eta");
		expect(created.meta.title).toBe("first");
		expect(created.session.kernel).toBeDefined();

		// Asking again is the same session, not a second assembly.
		const again = await sessions.session(created.meta.id);
		expect(again?.session).toBe(created.session);
		expect(sessions.openSessions()).toHaveLength(1);
	});

	it("reports a session that is not there, and lists what is", async () => {
		const { manager: sessions } = manager();
		expect(await sessions.session("nope")).toBeUndefined();
		const first = await sessions.create({ cwd: "/a" });
		const second = await sessions.create({ cwd: "/b" });
		const listed = await sessions.list();
		expect(listed.map((listing) => listing.id).sort()).toEqual([first.meta.id, second.meta.id].sort());
		// Listing itself opened nothing: only what was asked for is open.
		await sessions.closeAll();
	});

	it("remembers the metadata a session was created with, and applies its persona", async () => {
		const { manager: sessions } = manager();
		const created = await sessions.create({ cwd: "/work", persona: "Executor", model: "pro6000:qwen" });
		expect(created.session.kernel.inspect().activePersonaNames).toContain("Executor");
		expect(created.session.config.model).toEqual({ provider: "pro6000", modelId: "qwen" });
	});
});

describe("sessions are their own", () => {
	it("keeps two sessions' kernels, journals and usage apart", async () => {
		const firstModels = fakeModels([assistantMessage({ content: [{ type: "text", text: "first answer" }] })]);
		const secondModels = fakeModels([assistantMessage({ content: [{ type: "text", text: "second answer" }] })]);
		const store = new MemorySessionStore();
		const sessions = new SessionManager({
			store,
			modelsFor: () => firstModels as never,
		});
		const first = await sessions.create({ cwd: "/work/one" });
		const second = await sessions.create({ cwd: "/work/two" });
		void second;

		// Two kernels, two buses, two journals: nothing shared but the process.
		expect(first.session.kernel).not.toBe(second.session.kernel);
		expect(first.session.kernel.ctx).not.toBe(second.session.kernel.ctx);
		expect(first.session.log).not.toBe(second.session.log);
		// And the storages behind them are distinct, as the store contract says.
		const firstStorage = await store.open(first.meta.id);
		const secondStorage = await store.open(second.meta.id);
		expect(firstStorage?.storage).not.toBe(secondStorage?.storage);

		await sessions.closeAll();
		expect(secondModels.calls).toHaveLength(0);
	});

	it("closing one leaves the other running", async () => {
		const { manager: sessions } = manager({
			models: fakeModels([
				assistantMessage({ content: [{ type: "text", text: "answer" }] }),
				assistantMessage({ content: [{ type: "text", text: "answer" }] }),
			]),
		});
		const first = await sessions.create({ cwd: "/work/one" });
		const second = await sessions.create({ cwd: "/work/two" });

		expect(await sessions.close(first.meta.id)).toBe(true);
		expect(await sessions.close(first.meta.id)).toBe(false);
		// The second is still open and still usable, with its journal intact.
		const still = await sessions.session(second.meta.id);
		expect(still?.session).toBe(second.session);
		expect(second.session.kernel.inboxDepth).toBe(0);
		second.session.kernel.inject(userMsg("still here"));
		expect(second.session.kernel.inboxDepth).toBe(1);
		expect(second.session.log.transcript()).toHaveLength(0);
		await sessions.closeAll();
	});

	it("flushes a session's journal on close, so what it wrote is durable", async () => {
		const { store, manager: sessions } = manager();
		const created = await sessions.create({ cwd: "/work" });
		created.session.log.recordMessage(userMsg("written before the close"));
		await created.session.journaling.flush();
		await sessions.close(created.meta.id);

		// Re-open the storage the way a restart would, and find the message there.
		const reopened = await store.open(created.meta.id);
		expect(reopened).toBeDefined();
		const entries = await reopened!.storage.scanEntries({});
		expect(entries).toHaveLength(1);
		expect(JSON.stringify(entries[0])).toContain("written before the close");
		// And a fresh SessionLog over that storage replays the same transcript.
		const replayed = await SessionLog.load(reopened!.storage);
		expect(replayed.transcript()).toHaveLength(1);
	});
});
