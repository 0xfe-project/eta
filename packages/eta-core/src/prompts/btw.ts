/**
 * Model-visible lines for the btw side channel: the system prompt the side
 * request runs under, and the handoff note injected when a side thread has results.
 */

/**
 * The side thread is an aside, not a second worker. Main-session messages ride
 * along as context only, so the side model must not pick up unfinished work.
 */
const BTW_SYSTEM_PROMPT_BASE = [
	"You are having an aside conversation with the user, separate from their main working session.",
	"Main-session messages, when present, are context only — that work is being handled elsewhere; do not continue it or report on it.",
	"Answer the side question directly and briefly. If the user asks you to prepare something for the main session, say so instead of acting on it.",
].join(" ");

export function btwSystemPrompt(kind: "contextual" | "tangent" = "contextual"): string {
	return kind === "tangent"
		? `${BTW_SYSTEM_PROMPT_BASE} This thread carries no main-session context: rely only on what the user writes here.`
		: BTW_SYSTEM_PROMPT_BASE;
}

export function btwHandoff(id: string): string {
	return `[btw ${id}] side thread has results: fold them in or summarize for the user.`;
}
