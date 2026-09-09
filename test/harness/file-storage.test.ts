import { mkdtemp, rm } from "node:fs/promises";
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
					timestamp: NOW,
					role: "user",
					content: "hello",
				}),
				storedValues.setValue(storedValues.sessionName, "persisted"),
			],
			BACKGROUND_CONTEXT,
		);
		await opened.close(BACKGROUND_CONTEXT);

		const reopened = await FileStorage.load({ path }, BACKGROUND_CONTEXT);
		const entries = await reopened.getEntries(["e1"], BACKGROUND_CONTEXT);
		expect(entries.get("e1")).toBeDefined();
		expect((entries.get("e1") as { content?: string }).content).toBe("hello");
		expect(await reopened.getValue(storedValues.sessionName, BACKGROUND_CONTEXT)).toBeDefined();
		const stats = await reopened.getStats(BACKGROUND_CONTEXT);
		expect(stats.messageCount).toBe(1);
		await reopened.close(BACKGROUND_CONTEXT);
	});
});
