/**
 * Crash recovery against a real file (REFACTOR.md §K5 acceptance).
 *
 * A process is a storage handle, a crash is abandoning that handle, and the
 * disk is the path. The half-written line is put there by hand, the way a
 * killed process leaves it.
 */
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, type JournalCommit, Kernel, Runner, SessionLog } from "@eta/core";
import { assistantMessage, fakeProvider } from "@eta/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonlStorage } from "../src/index.ts";

let dir = "";
let counter = 0;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "eta-recovery-"));
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

function nextPath(): string {
	counter += 1;
	return join(dir, `session-${counter}.jsonl`);
}

const userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

const answer = (text: string) => assistantMessage({ content: [{ type: "text", text }], stopReason: "stop" });

/** A process: open the journal, run one turn, hand back the pieces. */
async function processRun(path: string, script: AssistantMessage[], prompt: string) {
	const storage = await JsonlStorage.open(path);
	const log = SessionLog.create(storage);
	const kernel = Kernel.create();
	const fake = fakeProvider(script);
	const runner = new Runner(kernel, { providers: fake, model: {} as never, journal: log });
	kernel.inject(userMsg(prompt));
	const result = await runner.run();
	kernel.dispose();
	return { storage, log, result, fake };
}

function linesOf(path: string): Promise<string[]> {
	return readFile(path, "utf8").then((raw) => raw.split("\n").filter((line) => line.trim().length > 0));
}

describe("crash recovery on disk", () => {
	it("a clean session's journal replays into the same state", async () => {
		const path = nextPath();
		const first = await processRun(path, [answer("the answer")], "first question");
		await first.log.endRun({ "session.model": "pro6000/k3" });
		await first.storage.close();

		const after = await JsonlStorage.open(path);
		const log = await SessionLog.load(after);
		expect(log.recovered.hadRunInFlight).toBe(false);
		expect(log.recovered.boundaries).toBe(2);
		expect(log.transcript()).toHaveLength(2);
		expect(await after.get("session.model")).toBe("pro6000/k3");
		await after.close();
	});

	it("a kill mid-run leaves a journal that reopens at the last boundary", async () => {
		const path = nextPath();
		const settled = await processRun(path, [answer("settled answer")], "settled question");
		await settled.storage.close();

		// A second process gets one turn in, then is killed with a line in flight.
		const dying = await JsonlStorage.open(path);
		const log = SessionLog.create(dying);
		await log.beginRun();
		log.stageMessage(userMsg("question the run will not finish") as never);
		await log.commitTurn();
		await dying.close();
		// What the killed process left behind: a torn append.
		await appendFile(path, `{"entries":[{"id":"half"`, "utf8");

		const reopened = await JsonlStorage.open(path);
		const repaired = await reopened.repairTornTail();
		expect(repaired.trailingOnly).toBe(true);
		expect(repaired.droppedRecords).toBe(1);

		const recovered = await SessionLog.load(reopened);
		expect(recovered.recovered.hadRunInFlight).toBe(true);
		expect(recovered.recovered.boundaries).toBe(1);
		expect(recovered.recovered.droppedEntries).toBe(1);
		expect(recovered.transcript().map((message) => JSON.stringify(message.content))).toEqual([
			JSON.stringify(userMsg("settled question").content),
			JSON.stringify([{ type: "text", text: "settled answer" }]),
		]);
		await recovered.storage.close();

		// The journal is clean and reusable afterwards.
		const raw = await linesOf(path);
		for (const line of raw) expect(() => JSON.parse(line)).not.toThrow();
		const commits = raw.map((line) => JSON.parse(line) as JournalCommit);
		expect(commits.some((commit) => commit.entries.length === 1 && commit.entries[0]?.type === "message")).toBe(true);
	});

	it("an aborted run's state write does not survive", async () => {
		const path = nextPath();
		const settled = await processRun(path, [answer("done")], "q");
		await settled.storage.set("phase", "ready");
		await settled.log.endRun({ phase: "ready" });
		await settled.storage.close();

		const dying = await JsonlStorage.open(path);
		const log = SessionLog.create(dying);
		await log.beginRun();
		await log.storage.set("phase", "half-migrated");
		log.stageMessage(userMsg("work in progress") as never);
		await log.commitTurn();
		await dying.close(); // killed: the run never reached a boundary

		const reopened = await JsonlStorage.open(path);
		const recovered = await SessionLog.load(reopened);
		expect(recovered.recovered.rolledBackValues).toEqual(["phase"]);
		expect(await reopened.get("phase")).toBe("ready");
		await recovered.storage.close();
	});
});
