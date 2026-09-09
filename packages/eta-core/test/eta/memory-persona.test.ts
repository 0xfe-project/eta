import { describe, expect, it } from "vitest";
import { MEMORY_SECTIONS, MemoryCache, applyExtraction, extractMemory, parseMemory, renderMemory, scanMemoryPaths } from "../../src/harness/memory.ts";
import { discoverPersonas, renderPersonaBlock } from "../../src/harness/persona.ts";
import type { EtaFs } from "../../src/harness/memory.ts";

function memFs(files: Record<string, string>): EtaFs & { touch(p: string): void } {
	const times = Object.fromEntries(Object.keys(files).map((k) => [k, 1000]));
	const dirList = (dir: string) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"));
	return {
		touch(p) { files[p] ??= ""; times[p] = (times[p] ?? 1000) + 500; },
		async readFile(p) { return files[p]; },
		async mtime(p) { return times[p] ?? (files[p] !== undefined ? 1000 : undefined); },
		async writeFile(p, c) { files[p] = c; times[p] = (times[p] ?? 1000) + 1; },
		async listFileNames(d) { return dirList(d); },
	};
}

describe("memory file round trip", () => {
	it("parses and renders the three sections with stable ids", () => {
		const text = renderMemory([
			{ id: 0, section: "decision", text: "must use bun" },
			{ id: 1, section: "lesson", text: "never alias deps blindly" },
		]);
		expect(parseMemory(text)).toEqual([
			{ id: 0, section: "decision", text: "must use bun" },
			{ id: 1, section: "lesson", text: "never alias deps blindly" },
		]);
		expect(MEMORY_SECTIONS).toEqual(["decision", "preference", "lesson"]);
	});
});

describe("scan rules", () => {
	it("walks up to the git root and appends home last", async () => {
		const fs = memFs({
			"/home/u/.eta/MEMORY.md": "## decision\n- home note",
			"/repo/.eta/MEMORY.md": "## decision\n- repo note",
			"/repo/.git": "x",
			"/repo/sub/deep.txt": "x",
		});
		const paths = await scanMemoryPaths(fs, "/repo/sub", "/home/u");
		expect(paths).toEqual(["/repo/.eta/MEMORY.md", "/home/u/.eta/MEMORY.md"]);
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
		await applyExtraction(fs, "/repo/.eta/MEMORY.md", { add_new_preference: ["tabs over spaces"] });
		const second = await cache.load("/repo");
		expect(second.text).toContain("tabs over spaces");
	});
});

describe("extraction", () => {
	it("appends new lines idempotently and honors removals", async () => {
		const fs = memFs({ "/m/MEMORY.md": renderMemory([{ id: 0, section: "decision", text: "keep" }]) });
		const a = await applyExtraction(fs, "/m/MEMORY.md", { add_new_decision: ["keep", "new"], remove_memory_ids: [] });
		expect(a).toEqual({ added: 1, removed: 0 });
		const b = await applyExtraction(fs, "/m/MEMORY.md", { add_new_decision: ["new"] });
		expect(b.added).toBe(0);
		const c = await applyExtraction(fs, "/m/MEMORY.md", { remove_memory_ids: [0] });
		expect(c.removed).toBe(1);
		expect(parseMemory((await fs.readFile("/m/MEMORY.md"))!).map((e) => e.text)).toEqual(["new"]);
	});
	it("out-of-band call parses provider JSON, silence on garbage", async () => {
		const fs = memFs({ "/m/MEMORY.md": "" });
		const r = await extractMemory(fs, "/m/MEMORY.md", "user said X", async () => 'noise {"learn_new_lesson":["ask earlier"],"add_new_decision":[],"add_new_preference":[],"remove_memory_ids":[]} noise');
		expect(r?.added).toBe(1);
		expect(await extractMemory(fs, "/m/MEMORY.md", "x", async () => "no json here")).toBeUndefined();
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
