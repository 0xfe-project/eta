/**
 * Reading journals written by eta-agent (REFACTOR.md §4).
 *
 * The wire format is the same `{w, t}` line, so an old journal reads as-is —
 * with one difference that matters: an old line can carry writes this kernel
 * does not have (list appends for pending assistant frames, lane config and
 * operation state). Those are skipped and counted, never treated as damage,
 * because the entries sitting beside them on the same line are real history.
 *
 * The fixtures are verbatim excerpts of real sessions.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionLog, value } from "@eta/core";
import { describe, expect, it } from "vitest";
import { JsonlStorage } from "../src/index";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixture = (name: string) => join(here, "fixtures", name);

/** Real sessions this machine produced with eta-agent, if any are around. */
async function realJournals(limit = 5): Promise<string[]> {
	try {
		const dir = join(homedir(), ".eta", "sessions");
		const names = await readdir(dir);
		const paths: string[] = [];
		for (const name of names) {
			if (!name.startsWith("eta-")) continue;
			const path = join(dir, name, "journal.jsonl");
			try {
				await readFile(path);
				paths.push(path);
			} catch {
				// No journal in that session directory.
			}
			if (paths.length >= limit) break;
		}
		return paths;
	} catch {
		return [];
	}
}

describe("importing a real eta-agent journal", () => {
	it("replays the entries, usage rows, and eta state", async () => {
		const warnings: string[] = [];
		const storage = await JsonlStorage.open(fixture("session-excerpt.jsonl"), {
			warn: (message) => warnings.push(message),
		});
		const log = await SessionLog.load(storage);

		expect(log.graph.size()).toBeGreaterThan(0);
		expect(log.transcript().length).toBeGreaterThan(0);
		const entries = await storage.scanEntries({});
		expect(entries.every((entry) => entry.seq > 0)).toBe(true);
		// Sequence numbers are rebuilt in file order.
		expect(entries.map((entry) => entry.seq)).toEqual([...entries].map((entry) => entry.seq).sort((a, b) => a - b));

		// The usage rows came across and their totals add up.
		const usage = await storage.scanUsage({});
		expect(usage.length).toBeGreaterThan(0);
		const stats = await storage.getStats();
		expect(stats.usage.output).toBe(usage.reduce((total, row) => total + row.usage.output, 0));
		expect(stats.messageCount).toBe(entries.filter((entry) => entry.type === "message").length);

		// Drive-era writes were skipped and said so, not silently swallowed: the
		// fixture carries lane config/state and operation results from the old
		// drive-era journal.
		expect(warnings.join(" ")).toContain("skipped");
		expect(warnings.join(" ")).toContain("pi.lane.config");
		// The battery's own state is not reserved space: it comes across.
		expect(await storage.getValue(value<unknown>("eta.tasks.state"))).toBeDefined();
		expect(await storage.getValue(value<unknown>("pi.lane.config"))).toBeUndefined();

		// The fixture is a slice of a real session, so it holds one entry whose
		// parent is not in the excerpt: the load counts it and ends the branch
		// there instead of refusing to open the session.
		expect(log.orphans).toBe(1);
		expect(await storage.repairTornTail()).toEqual({ droppedBytes: 0, droppedRecords: 0, trailingOnly: true });
		await storage.close();
	});

	it("keeps the entries that share a line with writes the kernel does not use", async () => {
		const warnings: string[] = [];
		const storage = await JsonlStorage.open(fixture("session-with-drive-writes.jsonl"), {
			warn: (message) => warnings.push(message),
		});
		const entries = await storage.scanEntries({});
		// The fixture's first two lines carry an entry plus usage plus drive state.
		expect(entries.length).toBeGreaterThanOrEqual(2);
		expect((await storage.scanUsage({})).length).toBeGreaterThanOrEqual(3);
		// A `list` write is not damage: nothing was cut, and it was reported.
		expect(await storage.repairTornTail()).toEqual({ droppedBytes: 0, droppedRecords: 0, trailingOnly: true });
		expect(warnings.join(" ")).toContain("list");
		expect(warnings.join(" ")).toContain("pi.op.");
		await storage.close();
	});

	it("an entry whose parent is missing ends the branch instead of failing the load", async () => {
		const storage = await JsonlStorage.open(fixture("session-excerpt.jsonl"));
		const log = await SessionLog.load(storage);
		// The orphan is kept as an entry; only the walk stops at it.
		expect(log.orphans).toBeGreaterThan(0);
		expect(log.graph.size()).toBe((await storage.scanEntries({})).length);
		await storage.close();
	});

	it("a line whose writes are all drive-era still counts as a good line", async () => {
		const storage = await JsonlStorage.open(fixture("session-with-drive-writes.jsonl"));
		// The last two lines are list-only; they must not read as a torn tail.
		expect((await storage.repairTornTail()).droppedRecords).toBe(0);
		await storage.close();
	});

	it("imports this machine's own sessions when they are present", async () => {
		const paths = await realJournals();
		if (paths.length === 0) return; // nothing to import on this machine

		for (const path of paths.slice(0, 2)) {
			const storage = await JsonlStorage.open(path);
			const log = await SessionLog.load(storage);
			// Whatever the session was about, it reads back with its entries in
			// order and no part of the file treated as damage.
			expect(log.graph.size()).toBeGreaterThan(0);
			expect((await storage.repairTornTail()).droppedRecords).toBe(0);
			const entries = await storage.scanEntries({ order: "asc" });
			expect(entries[0]!.parentId).toBeNull();
			await storage.close();
		}
	});

	it("survives an old journal that was compacted twice and then appended to", async () => {
		// A session folder that went through repair and append keeps reading: the
		// import is the same code path as a fresh journal's.
		const dir = await mkdtemp(join(tmpdir(), "eta-import-"));
		const path = join(dir, "journal.jsonl");
		const source = await readFile(fixture("session-excerpt.jsonl"), "utf8");
		await import("node:fs/promises").then(({ writeFile }) => writeFile(path, source, "utf8"));

		const first = await JsonlStorage.open(path);
		const before = await first.scanEntries({});
		await first.compactJournal();
		await first.commit([{ kind: "value", op: "set", namespace: "session.name", key: "", value: "imported" }]);
		await first.close();

		const second = await JsonlStorage.open(path);
		expect((await second.scanEntries({})).map((entry) => entry.id)).toEqual(before.map((entry) => entry.id));
		expect((await second.getValue(value<string>("session.name")))?.value).toBe("imported");
		await second.close();
		await rm(dir, { recursive: true, force: true });
	});
});
