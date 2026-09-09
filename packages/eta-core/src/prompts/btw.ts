/**
 * Model-visible handoff line injected when a side thread has results.
 */

export function btwHandoff(id: string): string {
	return `[btw ${id}] side thread has results: fold them in or summarize for the user.`;
}
