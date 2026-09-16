import { homedir } from "node:os";

export interface PlatformPromptInfo {
	/** The session's working directory — the project the agent is acting on. */
	cwd: string;
	home?: string;
	/** The eta config file the GUI edits: providers, models, headers. */
	configPath: string;
	/** The session's own directory, when the session is persisted. */
	sessionDir?: string;
	/** Where a note for this project would be written. */
	memoryTarget: string;
	/** Whether anything has been remembered for this project yet. */
	memoryExists: boolean;
}

/**
 * The platform briefing: what the app around this agent is made of and where its files
 * live, so the agent can change its own setup — write a persona card, take a project
 * note — instead of asking a human where things go.
 *
 * It lives in the server, not the harness, because it is a description of *this product*:
 * core knows how to inject a prompt block and nothing about `~/.eta`. The strings the
 * agent hears from core's own drivers (goal continuation, loop follow-ups) live in core's
 * prompts module; the strings that describe the app live here.
 *
 * It is stable for a session — the paths do not move — so it sits with the blocks a
 * provider cache keeps, and it is written in terms of this session's real paths, because
 * "create .eta/MEMORY.md" is only useful next to a directory the agent is standing in.
 */
export function renderPlatformBlock(info: PlatformPromptInfo): string {
	const home = info.home ?? homedir();
	const cwd = info.cwd;
	const lines: string[] = [
		"<platform>",
		"eta is the app running this session. Its own files are readable, and the ones that describe you are yours to change:",
		"",
		`Config: ${info.configPath} — the model providers: id, baseUrl, apiKey, the model list, and any per-provider \`headers\`. The GUI writes this file as well. Its apiKeys are secrets: consult them when a request needs debugging, never paste them back.`,
	];
	if (info.sessionDir !== undefined)
		lines.push(
			`This session's history: ${info.sessionDir} — \`meta.json\` (persona, cwd, title, model), \`journal.jsonl\` (every accepted change, append-only), \`dev.jsonl\` (what the app logged for itself). The journal is an internal format: the app rewrites it from the state it produced once it outgrows that state, so hand-editing it is not a supported operation.`,
		);
	lines.push(
		`Personas are markdown cards. Write \`<id>.persona.md\` into ${home}/.eta/persona (every session) or ${cwd}/.eta/persona (this project only): the file name is the persona id and the body is what gets injected as the persona block. Saving the file is enough — persona directories are re-read while the app runs, so a new card is pickable without a restart.`,
	);
	lines.push("");
	lines.push(
		info.memoryExists
			? `Memory belongs to the project, not to the session. This project's memory is ${info.memoryTarget}, and it is loaded above as the memory block. Read it before contradicting it; edit it like any file when a note goes stale — it is re-read every turn, and the app appends to it itself when a run ends.`
			: `Memory belongs to the project, not to the session, and nothing has been remembered here yet. When something is worth keeping, create ${cwd}/.eta/ and write MEMORY.md in it — the write creates the directory. The app treats the nearest .eta/MEMORY.md up the tree from the working directory as that project's memory, so ${info.memoryTarget} is where yours belongs.`,
	);
	lines.push(
		"What belongs in memory: decisions and why, constraints nobody wrote down, facts about this codebase that were expensive to learn. What does not: what you are doing right now, in-flight plans, anything the next session can re-derive in seconds. A note earns its line when reading it later beats working it out again.",
	);
	lines.push(
		"Loops and schedules run in the app rather than in a shell you hold open: a loop you created fires on its own clock and returns to this session as an injected message, so a run ending is not the loop ending.",
	);
	lines.push("</platform>");
	return lines.join("\n");
}
