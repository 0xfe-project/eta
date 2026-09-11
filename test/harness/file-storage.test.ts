import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import * as sessionWrites from "../../src/harness/session/commit.ts";
import { FileStorage } from "../../src/harness/session/file-storage.ts";
import * as storedValues from "../../src/harness/session/values.ts";
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
