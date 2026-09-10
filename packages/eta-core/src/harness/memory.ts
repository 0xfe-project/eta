/**
 * Memory battery (C5): a small untrusted NOTES file per project/user, read at
 * session start and refreshed when the file changes. Three fixed sections so
 * the extraction call and humans can both write it. The FS is injected so
 * tests and the GUI sandbox can supply their own.
 */

import { MEMORY_EXTRACT_PROMPT, MEMORY_EXTRACT_SYSTEM_PROMPT } from "../prompts/index.ts";

export interface EtaFs {
	readFile(path: string): Promise<string | undefined>;
	/** undefined when the path doesn't exist. */
	mtime(path: string): Promise<number | undefined>;
	writeFile(path: string, content: string): Promise<void>;
	listFileNames(dir: string): Promise<string[]>;
}

export const MEMORY_SECTIONS = ["decision", "preference", "lesson"] as const;
export type MemorySection = (typeof MEMORY_SECTIONS)[number];

export interface MemoryEntry {
	id: number;
	section: MemorySection;
	text: string;
}

export const MEMORY_FILE = "MEMORY.md";
export const MEMORY_CAP = 20_000;
const HEADER = "# eta memory (untrusted)";

export function parseMemory(text: string): MemoryEntry[] {
	const entries: MemoryEntry[] = [];
	let section: MemorySection | undefined;
	for (const line of text.split("\n")) {
		const heading = /^##\s+(\w+)/.exec(line);
		if (heading !== null) {
			section = (MEMORY_SECTIONS as readonly string[]).includes(heading[1])
				? (heading[1] as MemorySection)
				: undefined;
			continue;
		}
		if (section === undefined) continue;
		const item = /^-\s+(?:\[(\d+)\]\s+)?(.*)$/.exec(line.trim());
		if (item === null || item[2].length === 0) continue;
		entries.push({ id: item[1] === undefined ? entries.length : Number(item[1]), section, text: item[2] });
	}
	return entries;
}

export function renderMemory(entries: MemoryEntry[]): string {
	const lines = [HEADER];
	for (const section of MEMORY_SECTIONS) {
		lines.push(`## ${section}`);
		for (const e of entries) if (e.section === section) lines.push(`- [${e.id}] ${e.text}`);
	}
	return `${lines.join("\n")}\n`;
}

export function renderMemoryBlock(entries: MemoryEntry[]): string {
	const body = MEMORY_SECTIONS.map((section) => {
		const items = entries.filter((e) => e.section === section).map((e) => `- ${e.text}`);
		return items.length === 0 ? undefined : `## ${section}\n${items.join("\n")}`;
	})
		.filter((s) => s !== undefined)
		.join("\n");
	return `<memory>\n[untrusted notes collected earlier]\n${body}\n</memory>`;
}

/** Git-aware upward walk from cwd, plus ~/.eta; nearest project file wins. */
export async function scanMemoryPaths(fs: EtaFs, cwd: string, home: string): Promise<string[]> {
	const found: string[] = [];
	let dir = cwd;
	for (;;) {
		const candidate = `${dir}/.eta/${MEMORY_FILE}`;
		if ((await fs.mtime(candidate)) !== undefined) found.unshift(candidate);
		const isGitRoot = (await fs.mtime(`${dir}/.git`)) !== undefined || dir === "/";
		if (isGitRoot) break;
		const parent = dir.replace(/\/[^/]*$/, "") || "/";
		if (parent === dir) break;
		dir = parent;
	}
	const homeCandidate = `${home}/.eta/${MEMORY_FILE}`;
	if ((await fs.mtime(homeCandidate)) !== undefined) found.push(homeCandidate);
	return found;
}

/** Reads + renders memory, re-reading only when a file's mtime changed. */
export class MemoryCache {
	private signature = "";
	private cached = { text: "", files: [] as string[] };

	private readonly fs: EtaFs;
	private readonly home: string;

	constructor(fs: EtaFs, home: string) {
		this.fs = fs;
		this.home = home;
	}

	async load(cwd: string): Promise<{ text: string; files: string[] }> {
		const paths = await scanMemoryPaths(this.fs, cwd, this.home);
		const stamps = await Promise.all(paths.map(async (p) => `${p}:${(await this.fs.mtime(p)) ?? 0}`));
		const signature = stamps.join("|");
		if (signature === this.signature) return this.cached;
		let entries: MemoryEntry[] = [];
		let nextId = 0;
		for (const path of paths) {
			const text = await this.fs.readFile(path);
			if (text === undefined) continue;
			for (const e of parseMemory(text)) entries.push({ ...e, id: nextId++ });
		}
		let block = renderMemoryBlock(entries);
		if (block.length > MEMORY_CAP) block = `${block.slice(0, MEMORY_CAP)}\n[memory truncated at cap]`;
		this.signature = signature;
		this.cached = { text: block, files: paths };
		return this.cached;
	}
}

export interface MemoryExtraction {
	add_new_decision: string[];
	add_new_preference: string[];
	learn_new_lesson: string[];
	remove_memory_ids: number[];
}

/** Idempotent append/remove on one memory file; existing texts are never duplicated. */
export async function applyExtraction(
	fs: EtaFs,
	path: string,
	extraction: Partial<MemoryExtraction>,
): Promise<{ added: number; removed: number }> {
	const existingTexts = parseMemory((await fs.readFile(path)) ?? "");
	const known = new Set(existingTexts.map((e) => e.text.trim()));
	const removeIds = new Set(extraction.remove_memory_ids ?? []);
	let nextId = existingTexts.reduce((m, e) => Math.max(m, e.id + 1), 0);
	const entries = existingTexts.filter((e) => !removeIds.has(e.id));
	let added = 0;
	const adds: [MemorySection, string[]][] = [
		["decision", extraction.add_new_decision ?? []],
		["preference", extraction.add_new_preference ?? []],
		["lesson", extraction.learn_new_lesson ?? []],
	];
	for (const [section, texts] of adds) {
		for (const text of texts) {
			if (known.has(text.trim())) continue;
			known.add(text.trim());
			entries.push({ id: nextId++, section, text });
			added += 1;
		}
	}
	await fs.writeFile(path, renderMemory(entries));
	return { added, removed: existingTexts.filter((e) => removeIds.has(e.id)).length };
}

/** Out-of-band extraction call: the agent never sees this conversation fork. */
export async function extractMemory(
	fs: EtaFs,
	path: string,
	transcriptText: string,
	call: (systemPrompt: string, prompt: string) => Promise<string>,
): Promise<{ added: number; removed: number } | undefined> {
	const raw = await call(MEMORY_EXTRACT_SYSTEM_PROMPT, `${MEMORY_EXTRACT_PROMPT}\n\nConversation:\n${transcriptText}`);
	const jsonMatch = /\{[\s\S]*\}/.exec(raw);
	if (jsonMatch === null) return undefined;
	try {
		return await applyExtraction(fs, path, JSON.parse(jsonMatch[0]) as Partial<MemoryExtraction>);
	} catch {
		return undefined;
	}
}
