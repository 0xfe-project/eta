/**
 * Persona summaries for the new-session wizard (GUI-PLAN v2 W0.4).
 * Discovery is re-run on every call, so dropping a .persona.md into
 * .eta/persona/ shows up in an open wizard with no restart.
 */

import { watch as fsWatch } from "node:fs";
import { homedir } from "node:os";
import { discoverPersonas, renderPersonaBlock } from "@eta/core";
import { builtinPersonas } from "@eta/core/prompts";
import { NodeEtaFs } from "./node-fs.ts";

export interface PersonaSummary {
	id: string;
	name: string;
	description: string;
	custom: boolean;
}

export async function listPersonaSummaries(cwd: string, home = homedir()): Promise<PersonaSummary[]> {
	const cards = await discoverPersonas(new NodeEtaFs(), cwd, home);
	const builtin = new Set(Object.keys(builtinPersonas()));
	return Object.entries(cards).map(([id, text]) => ({
		id,
		name: id,
		description: describeCard(text),
		custom: !builtin.has(id),
	}));
}

export async function renderPersonaFor(
	cwd: string,
	personaId: string,
	home = homedir(),
): Promise<{ names: string[]; text: string } | undefined> {
	const cards = await discoverPersonas(new NodeEtaFs(), cwd, home);
	if (!(personaId in cards)) return undefined;
	return { names: [personaId], text: renderPersonaBlock([personaId], cards).text };
}

function describeCard(text: string): string {
	for (const line of text.split("\n")) {
		const clean = line
			.replace(/^#+\s*/, "")
			.replace(/^>\s*/, "")
			.trim();
		if (clean.length > 0) return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
	}
	return "";
}

/** Watch every persona directory (home + cwd chain) and fire onChange on changes. Best-effort. */
export function watchPersonaDirs(cwd: string, onChange: () => void): void {
	for (const dir of [`${homedir()}/.eta/persona`, `${cwd}/.eta/persona`]) {
		try {
			const watcher = fsWatch(dir, { persistent: false }, () => onChange());
			watcher.on("error", () => {
				/* dir removed or watch failed: persona hot-reload degrades to fetch-on-open */
			});
		} catch {
			/* dir may not exist yet */
		}
	}
}
