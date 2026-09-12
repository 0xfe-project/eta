import { describe, expect, it } from "vitest";
import {
	MEMORY_SECTIONS,
	MemoryCache,
	applyExtraction,
	extractMemory,
	memoryExtractionHook,
	memoryFileLabel,
	parseMemory,
	renderMemory,
	renderMemoryBlock,
	scanMemory,
	scanMemoryPaths,
	type MemoryExtractionOutcome,
	type MemoryFile,
} from "../../src/harness/memory.ts";
import { discoverPersonas, renderPersonaBlock } from "../../src/harness/persona.ts";
import type { EtaFs } from "../../src/harness/memory.ts";

function memFs(files: Record<string, string>): EtaFs & { touch(p: string): void } {
	const times = Object.fromEntries(Object.keys(files).map((k) => [k, 1000]));
	const dirList = (dir: string) =>
		Object.keys(files).filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"));
	return {
		touch(p) {
			files[p] ??= "";
			times[p] = (times[p] ?? 1000) + 500;
		},
		async readFile(p) {
			return files[p];
		},
		async mtime(p) {
			return times[p] ?? (files[p] !== undefined ? 1000 : undefined);
		},
		async writeFile(p, c) {
			files[p] = c;
			times[p] = (times[p] ?? 1000) + 1;
		},
		async listFileNames(d) {
			return dirList(d);
		},
	};
}

const local: MemoryFile = { path: "/m/MEMORY.md", label: "m" };
const stored = (num: number, section: "decision" | "preference" | "lesson", text: string) => ({
	id: `m#${num}`,
	num,
	file: "/m/MEMORY.md",
	section,
	text,
});

describe("memory file round trip", () => {
	it("parses and renders the three sections with stable ids", () => {
		const text = renderMemory([stored(0, "decision", "must use bun"), stored(1, "lesson", "never alias deps blindly")]);
		expect(parseMemory(text, local)).toEqual([
			stored(0, "decision", "must use bun"),
			stored(1, "lesson", "never alias deps blindly"),
		]);
		expect(MEMORY_SECTIONS).toEqual(["decision", "preference", "lesson"]);
	});

	it("shows the id the model has to quote back to delete a note", () => {
		expect(renderMemoryBlock(parseMemory("## preference\n- [3] tabs over spaces", local))).toContain(
			"- [m#3] tabs over spaces",
		);
	});

	it("numbers a hand-written note without one, and keeps that number", () => {
		const parsed = parseMemory("## decision\n- no id here\n- [7] numbered", local);
		expect(parsed.map((e) => e.id)).toEqual(["m#0", "m#7"]);
		expect(parseMemory(renderMemory(parsed), local).map((e) => e.id)).toEqual(["m#0", "m#7"]);
	});
});

describe("scan rules", () => {
	it("walks up to the git root and stops there — the home file is not read", async () => {
		const fs = memFs({
			"/home/u/.eta/MEMORY.md": "## decision\n- home note",
			"/repo/.eta/MEMORY.md": "## decision\n- repo note",
			"/repo/.git": "x",
			"/repo/sub/deep.txt": "x",
		});
		const files = await scanMemoryPaths(fs, "/repo/sub", "/home/u");
		expect(files.map((f) => f.path)).toEqual(["/repo/.eta/MEMORY.md"]);
		expect(files[0]?.label.startsWith("repo~")).toBe(true);
	});

	it("makes the opened folder the project when there is no checkout above it", async () => {
		const fs = memFs({ "/work/notes.txt": "x" });
		const scan = await scanMemory(fs, "/work", "/home/u");
		expect(scan.files).toEqual([]);
		expect(scan.projectRoot).toBe("/work");
		// No notes anywhere: the scan still names the file the first note will create.
		expect(scan.target.path).toBe("/work/.eta/MEMORY.md");
	});

	it("writes to the nearest project file when the tree keeps several", async () => {
		const fs = memFs({
			"/repo/.eta/MEMORY.md": "## decision\n- repo-wide",
			"/repo/sub/.eta/MEMORY.md": "## decision\n- sub only",
			"/repo/.git": "x",
		});
		const scan = await scanMemory(fs, "/repo/sub", "/home/u");
		expect(scan.files.map((f) => f.path)).toEqual(["/repo/.eta/MEMORY.md", "/repo/sub/.eta/MEMORY.md"]);
		expect(scan.target.path).toBe("/repo/sub/.eta/MEMORY.md");
	});
});

describe("memory cache", () => {
	it("serves cached bytes until an mtime changes", async () => {
		const fs = memFs({ "/repo/.eta/MEMORY.md": "## decision\n- [0] use bun", "/repo/.git": "x" });
		const cache = new MemoryCache(fs, "/home/u");
		const first = await cache.load("/repo");
		expect(first.text).toContain("<memory>");
		expect(first.text).toContain("use bun");
		const same = await cache.load("/repo");
		expect(same.text).toBe(first.text);
		const target: MemoryFile = {
			path: "/repo/.eta/MEMORY.md",
			label: memoryFileLabel("/repo/.eta/MEMORY.md", "/home/u"),
		};
		await applyExtraction(fs, target, { add_new_preference: ["tabs over spaces"] });
		const second = await cache.load("/repo");
		expect(second.text).toContain("tabs over spaces");
	});

	it("keeps one note's id the same however many files merge", async () => {
		const fs = memFs({
			"/repo/.eta/MEMORY.md": "## preference\n- [1] speaks Chinese",
			"/repo/sub/.eta/MEMORY.md": "## decision\n- [0] use bun",
			"/repo/.git": "x",
		});
		const cache = new MemoryCache(fs, "/home/u");
		const first = await cache.load("/repo/sub");
		const outer = memoryFileLabel("/repo/.eta/MEMORY.md", "/home/u");
		expect(first.text).toContain(`[${outer}#1]`);
		// A note added to the other file must not renumber the first one.
		await fs.writeFile("/repo/sub/.eta/MEMORY.md", "## decision\n- [0] use bun\n- [1] bun only\n");
		expect((await cache.load("/repo/sub")).text).toContain(`[${outer}#1]`);
	});

	it("points at a file that does not exist yet, and reloads once it appears", async () => {
		const fs = memFs({ "/repo/.git": "x" });
		const cache = new MemoryCache(fs, "/home/u");
		const empty = await cache.load("/repo");
		expect(empty.files).toEqual([]);
		expect(empty.target.path).toBe("/repo/.eta/MEMORY.md");
		await applyExtraction(fs, empty.target, { add_new_preference: ["tabs over spaces"] });
		const loaded = await cache.load("/repo");
		expect(loaded.files).toEqual(["/repo/.eta/MEMORY.md"]);
		expect(loaded.text).toContain("tabs over spaces");
	});
});

describe("extraction", () => {
	it("appends new lines idempotently and honors removals", async () => {
		const fs = memFs({ "/m/MEMORY.md": renderMemory([stored(0, "decision", "keep")]) });
		const a = await applyExtraction(fs, local, { add_new_decision: ["keep", "new"], remove_memory_ids: [] });
		expect(a).toEqual({ added: 1, removed: 0, foreign: 0 });
		const b = await applyExtraction(fs, local, { add_new_decision: ["new"] });
		expect(b.added).toBe(0);
		const c = await applyExtraction(fs, local, { remove_memory_ids: ["m#0"] });
		expect(c.removed).toBe(1);
		expect(parseMemory((await fs.readFile("/m/MEMORY.md"))!, local).map((e) => e.text)).toEqual(["new"]);
	});
	it("reports an id from another file instead of deleting a same-numbered row", async () => {
		const fs = memFs({ "/m/MEMORY.md": renderMemory([stored(0, "decision", "keep")]) });
		const r = await applyExtraction(fs, local, { remove_memory_ids: ["user#0"] });
		expect(r).toEqual({ added: 0, removed: 0, foreign: 1 });
		expect(parseMemory((await fs.readFile("/m/MEMORY.md"))!, local).map((e) => e.text)).toEqual(["keep"]);
	});
	it("out-of-band call parses provider JSON, silence on garbage", async () => {
		const fs = memFs({ "/m/MEMORY.md": "" });
		const r = await extractMemory(
			fs,
			local,
			"user said X",
			async () =>
				'noise {"learn_new_lesson":["ask earlier"],"add_new_decision":[],"add_new_preference":[],"remove_memory_ids":[]} noise',
		);
		expect(r?.added).toBe(1);
		expect(await extractMemory(fs, local, "x", async () => "no json here")).toBeUndefined();
	});
});

describe("extraction before compaction", () => {
	type HookEvent = Parameters<ReturnType<typeof memoryExtractionHook>>[0];
	const noContext = undefined as never;
	const compactionEvent = (said: string[]): HookEvent =>
		({
			reason: "threshold",
			preparation: {
				messagesToSummarize: said.map((line) => ({ role: "user", content: [{ type: "text", text: line }] })),
				retainedTail: [],
			},
			lane: "main",
			runId: "run-1",
		}) as unknown as HookEvent;
	const longEnough = ["a".repeat(120), "b".repeat(120)];
	const found = '{"add_new_decision":["bun only"],"add_new_preference":[],"learn_new_lesson":[],"remove_memory_ids":[]}';

	it("writes what the provider found and reports the counts", async () => {
		const fs = memFs({ "/m/MEMORY.md": renderMemory([stored(0, "decision", "keep this one")]) });
		const prompts: string[] = [];
		const outcomes: MemoryExtractionOutcome[] = [];
		const hook = memoryExtractionHook(
			{
				fs,
				target: local,
				call: async (_system, prompt) => {
					prompts.push(prompt);
					return found;
				},
			},
			(outcome) => outcomes.push(outcome),
		);
		await expect(hook(compactionEvent(longEnough), noContext)).resolves.toBeUndefined();
		expect(parseMemory((await fs.readFile("/m/MEMORY.md"))!, local).map((e) => e.text)).toEqual([
			"keep this one",
			"bun only",
		]);
		expect(outcomes).toEqual([{ added: 1, removed: 0, foreign: 0, reason: "threshold" }]);
		// The notes ride along with ids, or the model has nothing to mark obsolete.
		expect(prompts[0]).toContain("- [m#0] keep this one");
		expect(prompts[0]).toContain("Conversation:");
	});

	it("spends no call on a stretch too thin to be worth notes", async () => {
		const fs = memFs({ "/m/MEMORY.md": "" });
		let calls = 0;
		const outcomes: MemoryExtractionOutcome[] = [];
		const hook = memoryExtractionHook(
			{ fs, target: local, call: async () => ((calls += 1), found) },
			(outcome) => outcomes.push(outcome),
		);
		await hook(compactionEvent(["hi"]), noContext);
		expect(calls).toBe(0);
		expect(outcomes[0]?.skipped).toBe("thin");
	});

	it("a provider that is down never fails the compaction", async () => {
		const fs = memFs({ "/m/MEMORY.md": "" });
		const outcomes: MemoryExtractionOutcome[] = [];
		const hook = memoryExtractionHook(
			{
				fs,
				target: local,
				call: async () => {
					throw new Error("connection reset");
				},
			},
			(outcome) => outcomes.push(outcome),
		);
		await expect(hook(compactionEvent(longEnough), noContext)).resolves.toBeUndefined();
		expect(outcomes[0]?.skipped).toBe("provider");
	});

	it("an extraction writes into the project it was collected in", async () => {
		const fs = memFs({ "/repo/.git": "x", "/repo/a.txt": "x" });
		const scan = await scanMemory(fs, "/repo", "/home/u");
		const found = '{"add_new_decision":["ship it"],"remove_memory_ids":[]}';
		const outcome = await extractMemory(fs, scan.target, "user: ship it\nassistant: done", async () => found);
		expect(outcome).toMatchObject({ added: 1, removed: 0 });
		expect(await fs.readFile("/repo/.eta/MEMORY.md")).toContain("ship it");
		// The home file stays untouched: no session's notes leak into another folder's.
		expect(await fs.readFile("/home/u/.eta/MEMORY.md")).toBeUndefined();
	});
});

describe("persona discovery", () => {
	it("custom card overrides the built-in by name", async () => {
		const fs = memFs({
			"/repo/.eta/persona/Thinker.persona.md": "I am the local Thinker.",
			"/repo/.git": "x",
		});
		const cards = await discoverPersonas(fs, "/repo", "/home/u");
		expect(cards.Thinker).toBe("I am the local Thinker.");
		expect(cards.Artist).toBeDefined();
	});
	it("renders requested names in order and reports misses", () => {
		const out = renderPersonaBlock(["Executor", "Ghost"], { Executor: "E" });
		expect(out.text).toBe("E");
		expect(out.missing).toEqual(["Ghost"]);
	});
});
