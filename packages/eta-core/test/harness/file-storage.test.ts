import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import * as sessionWrites from "../../src/harness/session/commit.ts";
import { FileStorage } from "../../src/harness/session/file-storage.ts";
import * as storedValues from "../../src/harness/session/values.ts";
import type { LaneConfiguration, LaneState } from "../../src/harness/session/types.ts";
import { createStorageConformance, type StorageFixture } from "../../src/harness/session/testing/index.ts";

const NOW = 1_700_000_000_000;
const dirs: string[] = [];

async function freshPath(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "eta-journal-"));
	dirs.push(dir);
	return join(dir, "journal.jsonl");
}

afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("FileStorage conformance", () => {
	for (const testCase of createStorageConformance(async () => {
		const storage = await FileStorage.load({ path: await freshPath(), now: () => NOW }, BACKGROUND_CONTEXT);
		return {
			storage,
			[Symbol.asyncDispose]: () => storage.close(BACKGROUND_CONTEXT),
		} satisfies StorageFixture;
	})) {
		it(`${testCase.group} > ${testCase.name}`, () => testCase.run());
	}
});


const usage = (input: number) => ({
	input,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input,
	cost: { input, output: 0, cacheRead: 0, cacheWrite: 0, total: input },
});

const messageEntry = (id: string, parentId: string | null, text: string) =>
	sessionWrites.insertEntry({
		id,
		parentId,
		type: "message",
		message: { role: "user", content: text, timestamp: NOW },
	});

describe("FileStorage journal replay", () => {
	it("reopens with identical entries, values and lists", async () => {
		const path = await freshPath();
		const opened = await FileStorage.load({ path, now: () => NOW }, BACKGROUND_CONTEXT);
		await opened.commit(
			[
				sessionWrites.insertEntry({
					id: "e1",
					parentId: null,
					type: "message",
					message: { role: "user", content: "hello", timestamp: NOW },
				}),
				storedValues.setValue(storedValues.sessionName, "persisted"),
			],
			BACKGROUND_CONTEXT,
		);
		await opened.close(BACKGROUND_CONTEXT);

		const reopened = await FileStorage.load({ path }, BACKGROUND_CONTEXT);
		const entries = await reopened.getEntries(["e1"], BACKGROUND_CONTEXT);
		expect(entries.get("e1")).toBeDefined();
		expect((entries.get("e1") as { message?: { content?: string } }).message?.content).toBe("hello");
		expect(await reopened.getValue(storedValues.sessionName, BACKGROUND_CONTEXT)).toBeDefined();
		const stats = await reopened.getStats(BACKGROUND_CONTEXT);
		expect(stats.messageCount).toBe(1);
		await reopened.close(BACKGROUND_CONTEXT);
	});

	it("keeps the later write when the journal holds one entry id twice", async () => {
		// How a real journal gets this shape: an interrupted run commits a placeholder
		// tool result, the late real output is committed under the same id, and the two
		// lines sit next to each other. Refusing to open over it would lose the session.
		const path = await freshPath();
		const line = (text: string, t: number) =>
			JSON.stringify({
				w: [
					sessionWrites.insertEntry({
						id: "e1",
						parentId: null,
						type: "message",
						message: { role: "user", content: text, timestamp: t },
					}),
				],
				t,
			});
		await writeFile(path, `${line("interrupted placeholder", NOW)}\n${line("the real result", NOW + 1)}\n`, "utf8");

		const opened = await FileStorage.load({ path }, BACKGROUND_CONTEXT);
		const entries = await opened.getEntries(["e1"], BACKGROUND_CONTEXT);
		expect((entries.get("e1") as { message: { content: string } }).message.content).toBe("the real result");
		expect((await opened.getStats(BACKGROUND_CONTEXT)).messageCount).toBe(1);
		await opened.close(BACKGROUND_CONTEXT);
	});

	it("still rejects a repeated id in a live commit", async () => {
		const path = await freshPath();
		const opened = await FileStorage.load({ path, now: () => NOW }, BACKGROUND_CONTEXT);
		const write = sessionWrites.insertEntry({
			id: "e1",
			parentId: null,
			type: "message",
			message: { role: "user", content: "once", timestamp: NOW },
		});
		await opened.commit([write], BACKGROUND_CONTEXT);
		await expect(opened.commit([write], BACKGROUND_CONTEXT)).rejects.toThrow("Duplicate entry or usage id");
		await opened.close(BACKGROUND_CONTEXT);
	});

	it("counts a replayed usage row once, under its latest figure", async () => {
		// The same id can reach the journal twice; the totals must follow the later row
		// rather than adding the two together.
		const path = await freshPath();
		const line = (input: number) =>
			JSON.stringify({
				w: [
					sessionWrites.insertUsage({
						id: "u1",
						usage: {
							input,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: input,
							cost: { input, output: 0, cacheRead: 0, cacheWrite: 0, total: input },
						},
						entryId: "e1",
						adjustment: false,
					}),
				],
				t: NOW,
			});
		await writeFile(path, `${line(10)}\n${line(25)}\n`, "utf8");

		const opened = await FileStorage.load({ path }, BACKGROUND_CONTEXT);
		expect((await opened.getStats(BACKGROUND_CONTEXT)).usage.input).toBe(25);
		await opened.close(BACKGROUND_CONTEXT);
	});

	it("stamps commits after a reopen with the caller's clock, not the replayed timestamp", async () => {
		const path = await freshPath();
		const opened = await FileStorage.load({ path, now: () => NOW }, BACKGROUND_CONTEXT);
		await opened.commit(
			[
				sessionWrites.insertEntry({
					id: "e1",
					parentId: null,
					type: "message",
					message: { role: "user", content: "first", timestamp: NOW },
				}),
			],
			BACKGROUND_CONTEXT,
		);
		await opened.close(BACKGROUND_CONTEXT);

		const reopened = await FileStorage.load({ path, now: () => NOW + 5_000 }, BACKGROUND_CONTEXT);
		const commit = await reopened.commit(
			[
				sessionWrites.insertEntry({
					id: "e2",
					parentId: "e1",
					type: "message",
					message: { role: "user", content: "later", timestamp: NOW + 5_000 },
				}),
			],
			BACKGROUND_CONTEXT,
		);
		expect(commit.timestamp).toBe(NOW + 5_000);
		const entries = await reopened.getEntries(["e1", "e2"], BACKGROUND_CONTEXT);
		expect(entries.get("e1")?.timestamp).toBe(NOW);
		expect(entries.get("e2")?.timestamp).toBe(NOW + 5_000);
		await reopened.close(BACKGROUND_CONTEXT);
	});

	it("cuts a torn tail off the journal instead of refusing to open", async () => {
		// A crash mid-append leaves half a line. The journal is append-only and any line
		// boundary is a valid state, so the repair is to stop there — otherwise every later
		// open throws on the same bytes and the session can never be reopened or written to.
		const path = await freshPath();
		const line = (id: string, text: string) =>
			JSON.stringify({
				w: [
					sessionWrites.insertEntry({
						id,
						parentId: id === "e1" ? null : "e1",
						type: "message",
						message: { role: "user", content: text, timestamp: NOW },
					}),
				],
				t: NOW,
			});
		await writeFile(path, `${line("e1", "kept")}\n{"w":[{"kind":"entr`, "utf8");

		const opened = await FileStorage.load({ path }, BACKGROUND_CONTEXT);
		expect((await opened.getEntries(["e1"], BACKGROUND_CONTEXT)).size).toBe(1);
		await opened.commit(
			[
				sessionWrites.insertEntry({
					id: "e2",
					parentId: "e1",
					type: "message",
					message: { role: "user", content: "written after the repair", timestamp: NOW },
				}),
			],
			BACKGROUND_CONTEXT,
		);
		await opened.close(BACKGROUND_CONTEXT);

		const reopened = await FileStorage.load({ path }, BACKGROUND_CONTEXT);
		expect((await reopened.getEntries(["e1", "e2"], BACKGROUND_CONTEXT)).size).toBe(2);
		await reopened.close(BACKGROUND_CONTEXT);
	});
});

describe("FileStorage journal repair and compaction", () => {
	// The repair is only real once it is on the disk: an in-memory repair fails the next
	// open exactly like the bytes it was meant to fix.
	it("cuts a torn tail off the file itself", async () => {
		const path = await freshPath();
		const kept = `${JSON.stringify({ w: [messageEntry("e1", null, "kept")], t: NOW })}\n`;
		await writeFile(path, `${kept}{"w":[{"kind":"entr`, "utf8");

		const opened = await FileStorage.load({ path }, BACKGROUND_CONTEXT);
		expect((await opened.getEntries(["e1"], BACKGROUND_CONTEXT)).size).toBe(1);
		expect((await stat(path)).size).toBe(Buffer.byteLength(kept));
		await opened.close(BACKGROUND_CONTEXT);
	});

	it("keeps the commits behind an unreadable line and rebuilds the journal without the hole", async () => {
		// Two writers over one directory can cut a line in half without touching the lines
		// around it. The history behind the hole was accepted like any other.
		const path = await freshPath();
		await writeFile(
			path,
			`${JSON.stringify({ w: [messageEntry("e1", null, "first")], t: NOW })}\nTHIS IS NO JOURNAL LINE AT ALL\n${JSON.stringify({ w: [messageEntry("e2", "e1", "behind the hole")], t: NOW })}\n`,
			"utf8",
		);

		const opened = await FileStorage.load({ path }, BACKGROUND_CONTEXT);
		expect((await opened.getEntries(["e1", "e2"], BACKGROUND_CONTEXT)).size).toBe(2);
		expect(await readFile(path, "utf8")).not.toContain("THIS IS NO JOURNAL LINE");
		await opened.close(BACKGROUND_CONTEXT);

		const reopened = await FileStorage.load({ path }, BACKGROUND_CONTEXT);
		expect((await reopened.getEntries(["e1", "e2"], BACKGROUND_CONTEXT)).size).toBe(2);
		await reopened.close(BACKGROUND_CONTEXT);
	});

	it("rebuilds the journal from live state and comes back identical", async () => {
		const path = await freshPath();
		const opened = await FileStorage.load({ path, now: () => NOW }, BACKGROUND_CONTEXT);
		const counter = storedValues.value<number>("test.counter");
		const frames = storedValues.list<string>("test.frames");
		await opened.commit(
			[
				messageEntry("e1", null, "hello"),
				sessionWrites.insertUsage({ id: "u1", usage: usage(30), entryId: "e1", adjustment: false }),
				storedValues.setValue(counter, 1),
			],
			BACKGROUND_CONTEXT,
		);
		// A response streaming: the frames are the journal's bulk and dead by the next commit.
		for (let index = 0; index < 200; index += 1)
			await opened.commit(
				[storedValues.setValue(counter, index + 2), storedValues.appendList(frames, `frame ${index}`)],
				BACKGROUND_CONTEXT,
			);
		await opened.commit([storedValues.deleteList(frames)], BACKGROUND_CONTEXT);
		const beforeBytes = (await stat(path)).size;
		// `seq` is a replay artifact on both sides of a rebuild, so the value is what has to match.
		const liveCounter = await opened.getValue(counter, BACKGROUND_CONTEXT);
		const liveStats = await opened.getStats(BACKGROUND_CONTEXT);

		const result = await opened.compact(BACKGROUND_CONTEXT);
		expect(result.rewritten).toBe(true);
		expect(result.afterBytes).toBeLessThan(beforeBytes);
		expect((await stat(path)).size).toBeLessThan(beforeBytes / 4);
		await opened.close(BACKGROUND_CONTEXT);

		const reopened = await FileStorage.load({ path }, BACKGROUND_CONTEXT);
		expect(await reopened.getValue(counter, BACKGROUND_CONTEXT)).toEqual(liveCounter && { ...liveCounter, seq: (await reopened.getValue(counter, BACKGROUND_CONTEXT))?.seq });
		expect(await reopened.readList(frames, undefined, BACKGROUND_CONTEXT)).toEqual([]);
		expect(await reopened.getStats(BACKGROUND_CONTEXT)).toEqual(liveStats);
		expect((await reopened.getEntries(["e1"], BACKGROUND_CONTEXT)).size).toBe(1);
		expect((await reopened.scanUsage({ limit: 10 }, BACKGROUND_CONTEXT)).length).toBe(1);
		await reopened.close(BACKGROUND_CONTEXT);
	});

	it("leaves the journal alone when another writer has grown it", async () => {
		// The rewrite erases the log to rewrite it. Lines this instance never saw are not in
		// the state it writes, so renaming would drop them without a word.
		const path = await freshPath();
		const opened = await FileStorage.load({ path, now: () => NOW }, BACKGROUND_CONTEXT);
		await opened.commit([messageEntry("e1", null, "mine")], BACKGROUND_CONTEXT);
		await appendFile(path, `${JSON.stringify({ w: [messageEntry("e2", "e1", "theirs")], t: NOW })}\n`, "utf8");

		const result = await opened.compact(BACKGROUND_CONTEXT);
		expect(result.rewritten).toBe(false);
		expect(result.reason).toBe("concurrent-writer");
		expect(await readFile(path, "utf8")).toContain("theirs");
		await opened.close(BACKGROUND_CONTEXT);
	});

	it(
		"rebuilds on its own once a long run goes quiet",
		async () => {
			const path = await freshPath();
			const opened = await FileStorage.load(
				{ path, now: () => NOW, compactGrowthBytes: 2_000, compactQuietMs: 10 },
				BACKGROUND_CONTEXT,
			);
			const frames = storedValues.list<string>("test.frames");
			for (let index = 0; index < 60; index += 1)
				await opened.commit([storedValues.appendList(frames, `frame ${index} with some padding`)], BACKGROUND_CONTEXT);
			await opened.commit([storedValues.deleteList(frames)], BACKGROUND_CONTEXT);
			const beforeBytes = (await stat(path)).size;
			// The rebuild waits for the session to go quiet, then notices the streaming
			// history it no longer needs. Waits in real time because the wait is the behavior.
			const deadline = Date.now() + 2_000;
			let afterBytes = beforeBytes;
			while (Date.now() < deadline && (afterBytes = (await stat(path)).size) >= beforeBytes)
				await new Promise((tick) => setTimeout(tick, 20));
			expect(afterBytes).toBeLessThan(beforeBytes);
			await opened.close(BACKGROUND_CONTEXT);
		},
		10_000,
	);

	it("keeps a small journal as it is", async () => {
		const path = await freshPath();
		const opened = await FileStorage.load({ path, now: () => NOW }, BACKGROUND_CONTEXT);
		await opened.commit([messageEntry("e1", null, "short and current")], BACKGROUND_CONTEXT);
		const beforeBytes = (await stat(path)).size;
		const result = await opened.compact(BACKGROUND_CONTEXT);
		expect(result.rewritten).toBe(false);
		expect(result.reason).toBe("not-worth-it");
		expect((await stat(path)).size).toBe(beforeBytes);
		await opened.close(BACKGROUND_CONTEXT);
	});
});

const laneConfiguration = {
	model: { provider: "test", modelId: "test" },
	thinkingLevel: "off",
	activeToolNames: ["read"],
} satisfies LaneConfiguration;
const idleLane = { currentOperationId: null, lastOperationId: null, inbox: [] } satisfies LaneState;

/** Three messages on one branch, with the lane rows a branch fork insists on seeing. */
async function branchOfThree(): Promise<{ path: string; storage: FileStorage }> {
	const path = await freshPath();
	const storage = await FileStorage.load({ path, now: () => NOW }, BACKGROUND_CONTEXT);
	await storage.commit(
		[
			messageEntry("e1", null, "first"),
			storedValues.setValue(storedValues.laneConfig("main"), laneConfiguration),
			storedValues.setValue(storedValues.laneState("main"), idleLane),
			storedValues.setValue(storedValues.branchTip("main"), "e1"),
		],
		BACKGROUND_CONTEXT,
	);
	await storage.commit([messageEntry("e2", "e1", "second"), storedValues.setValue(storedValues.branchTip("main"), "e2")], BACKGROUND_CONTEXT);
	await storage.commit([messageEntry("e3", "e2", "third"), storedValues.setValue(storedValues.branchTip("main"), "e3")], BACKGROUND_CONTEXT);
	return { path, storage };
}

describe("FileStorage fork", () => {
	it("copies the branch up to one entry into a journal of its own", async () => {
		const { path, storage } = await branchOfThree();
		const destination = join(path.replace(/journal\.jsonl$/, ""), "fork", "journal.jsonl");
		const fork = await storage.forkInto(destination, { scope: "branch", branch: "main", entryId: "e2" }, BACKGROUND_CONTEXT);

		expect(fork.entries).toBe(2);
		// A journal the caller can open the moment the call returns is the whole promise: a
		// fork whose newest message is still in the page cache lost that message.
		expect((await stat(destination)).size).toBeGreaterThan(0);

		const opened = await FileStorage.load({ path: destination }, BACKGROUND_CONTEXT);
		expect((await opened.getEntries(["e1", "e2", "e3"], BACKGROUND_CONTEXT)).size).toBe(2);
		expect(await opened.getValue(storedValues.branchTip("main"), BACKGROUND_CONTEXT)).toMatchObject({ value: "e2" });
		// The copy starts idle whatever the parent had recorded: a fork inherits a past, not a
		// run another session is still waiting on.
		expect((await opened.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT))?.value).toEqual({
			currentOperationId: null,
			lastOperationId: null,
			inbox: [],
		});
		await opened.close(BACKGROUND_CONTEXT);
		await storage.close(BACKGROUND_CONTEXT);
	});

	it("cuts the chosen message out when the fork is asked to stop above it", async () => {
		const { path, storage } = await branchOfThree();
		const destination = join(path.replace(/journal\.jsonl$/, ""), "before", "journal.jsonl");
		const fork = await storage.forkInto(
			destination,
			{ scope: "branch", branch: "main", entryId: "e2", position: "before" },
			BACKGROUND_CONTEXT,
		);
		expect(fork.entries).toBe(1);
		const opened = await FileStorage.load({ path: destination }, BACKGROUND_CONTEXT);
		expect(await opened.getValue(storedValues.branchTip("main"), BACKGROUND_CONTEXT)).toMatchObject({ value: "e1" });
		await opened.close(BACKGROUND_CONTEXT);
		await storage.close(BACKGROUND_CONTEXT);
	});

	it("writes nothing at all when the entry is not on the branch, and keeps taking writes", async () => {
		const { path, storage } = await branchOfThree();
		const destination = join(path.replace(/journal\.jsonl$/, ""), "nope", "journal.jsonl");
		await expect(
			storage.forkInto(destination, { scope: "branch", branch: "main", entryId: "somewhere-else" }, BACKGROUND_CONTEXT),
		).rejects.toThrow(/is not on source branch/);
		await expect(stat(destination)).rejects.toThrow();

		// The refusal is one call's failure, not the session's: the append queue behind it is
		// still live, or a refused fork would quietly break the session that was asked for it.
		await storage.commit([messageEntry("e4", "e3", "fourth"), storedValues.setValue(storedValues.branchTip("main"), "e4")], BACKGROUND_CONTEXT);
		await storage.close(BACKGROUND_CONTEXT);
		const reopened = await FileStorage.load({ path }, BACKGROUND_CONTEXT);
		expect((await reopened.getStats(BACKGROUND_CONTEXT)).messageCount).toBe(4);
		await reopened.close(BACKGROUND_CONTEXT);
	});
});
