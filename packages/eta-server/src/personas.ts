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

/** The card a session falls back to when its own card is gone; built-ins always hold it. */
const FALLBACK_PERSONA = "Thinker";

/**
 * Which card a persisted session reopens under.
 *
 * A persona is one file; a session is its whole history. So a card that was deleted, or an
 * id that was typed by hand before the built-in cards settled their casing, must not take the
 * session out of the sidebar with it: the lookup widens from exact, to the same id under
 * another case, to the fallback card. The caller says out loud when it fell back.
 */
export async function resolvePersonaId(
	cwd: string,
	personaId: string,
	home = homedir(),
): Promise<{ id: string; exact: boolean }> {
	const cards = await discoverPersonas(new NodeEtaFs(), cwd, home);
	if (personaId in cards) return { id: personaId, exact: true };
	const wanted = personaId.toLowerCase();
	const folded = Object.keys(cards).find((id) => id.toLowerCase() === wanted);
	if (folded !== undefined) return { id: folded, exact: false };
	return { id: FALLBACK_PERSONA, exact: false };
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
