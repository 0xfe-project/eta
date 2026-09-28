/**
 * Task prompts (verbatim port of eta-agent's `prompts/tasks.ts`, itself a port
 * of todo.rs).
 *
 * Model-visible text lives here rather than in the tools that return it: the
 * prompts module owns the words, so a deployment can review what its agent says
 * in one place.
 */
import type { AgentMessage } from "@eta/core";

/** What the task tools answer with after a write. */
export const TASK_UPDATE_SUCCESS = "Updated TODOs. FOLLOW and update your TODO list as you progress.";

/** Injected at the start of a turn when the session has tasks worth reviewing. */
export const TASK_REVIEW_PROMPT =
	"Before anything else, review your current task list (<current_tasks>...</current_tasks> above):" +
	"\n- Are there tasks that are now completed? Mark them done." +
	"\n- Are there tasks that are stale or no longer relevant? Cancel them." +
	"\n- Are there any new tasks implied by the current conversation that should be added?" +
	"\nAfter updating the list (if needed), continue working on the highest-priority pending or in-progress item.";

/**
 * The transient nudge one request carries when the reminder cadence says a review
 * is due (eta-agent's `transform_context` injection, message for message).
 *
 * It is a user message wrapped in `<system-reminder>`, appended after the
 * transcript for that request only: the model reads it next to the conversation,
 * the transcript never gains a message the user did not send, and a compaction has
 * nothing to preserve. The system prompt is untouched, so the cacheable prefix
 * stays byte-identical whether the reminder fired or not.
 */
export function taskReminderMessage(text: string = TASK_REVIEW_PROMPT): AgentMessage {
	return {
		role: "user",
		content: `<system-reminder>\n${text}\n</system-reminder>`,
		timestamp: Date.now(),
	} as AgentMessage;
}
