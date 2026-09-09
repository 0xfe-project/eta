/**
 * Persona battery (C9): four built-in prose cards (src/prompts/persona.ts)
 * share one namespace with `.eta/persona/*.persona.md` cards found by the
 * same git-aware walk as memory; custom cards override built-ins by name.
 * Cards are untrusted content rendered into the stable prompt block.
 */

import { builtinPersonas } from "../prompts/index.ts";
import type { EtaFs } from "./memory.ts";

const CARD_SUFFIX = ".persona.md";

/** Merge built-ins with custom cards; nearest project card wins over home. */
export async function discoverPersonas(fs: EtaFs, cwd: string, home: string): Promise<Record<string, string>> {
	const dirs: string[] = [`${home}/.eta/persona`];
	let dir = cwd;
	for (;;) {
		dirs.push(`${dir}/.eta/persona`);
		const isGitRoot = (await fs.mtime(`${dir}/.git`)) !== undefined || dir === "/";
		if (isGitRoot) break;
		const parent = dir.replace(/\/[^/]*$/, "") || "/";
		if (parent === dir) break;
		dir = parent;
	}
	const cards = builtinPersonas();
	for (const d of dirs) {
		for (const listed of await fs.listFileNames(d)) {
			if (!listed.endsWith(CARD_SUFFIX)) continue;
			const path = listed.includes("/") ? listed : `${d}/${listed}`;
			const base = path.slice(path.lastIndexOf("/") + 1);
			const text = await fs.readFile(path);
			if (text !== undefined) cards[base.slice(0, -CARD_SUFFIX.length)] = text;
		}
	}
	return cards;
}

export function renderPersonaBlock(names: string[], cards: Record<string, string>): { text: string; missing: string[] } {
	const missing: string[] = [];
	const parts: string[] = [];
	for (const name of names) {
		const card = cards[name];
		if (card === undefined) missing.push(name);
		else parts.push(card.trim());
	}
	return { text: parts.join("\n\n"), missing };
}
