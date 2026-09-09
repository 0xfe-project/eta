/**
 * Persona summaries for the new-session wizard (GUI-PLAN v2 W0.4).
 * Discovery is re-run on every call, so dropping a .persona.md into
 * .eta/persona/ shows up in an open wizard with no restart.
 */

import { homedir } from "node:os";
import { discoverPersonas, renderPersonaBlock } from "@eta/core";
import { NodeEtaFs } from "./node-fs.ts";

export interface PersonaSummary {
	id: string;
	name: string;
	description: string;
}

export async function listPersonaSummaries(cwd: string, home = homedir()): Promise<PersonaSummary[]> {
	const cards = await discoverPersonas(new NodeEtaFs(), cwd, home);
	return Object.entries(cards).map(([id, text]) => ({ id, name: id, description: describeCard(text) }));
}

export async function renderPersonaFor(cwd: string, personaId: string, home = homedir()): Promise<{ names: string[]; text: string } | undefined> {
	const cards = await discoverPersonas(new NodeEtaFs(), cwd, home);
	if (!(personaId in cards)) return undefined;
	return { names: [personaId], text: renderPersonaBlock([personaId], cards).text };
}

function describeCard(text: string): string {
	for (const line of text.split("\n")) {
		const clean = line.replace(/^#+\s*/, "").replace(/^>\s*/, "").trim();
		if (clean.length > 0) return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
	}
	return "";
}
