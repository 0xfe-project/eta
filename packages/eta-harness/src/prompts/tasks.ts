/**
 * Step prompts (port of eta-agent's `prompts/tasks.ts`, itself a port of
 * todo.rs).
 *
 * Model-visible text lives here rather than in the tools that return it: the
 * prompts module owns the words, so a deployment can review what its agent says
 * in one place.
 *
 * A step is one line of the plan a session keeps for itself — what it is doing
 * right now and in what order. It is not a board task: a board task is a unit of
 * work that outlives the conversation, and it is proposed with `draft_task`.
 */
import type { AgentMessage, Task, TaskStatus } from "@eta/core";

/** What the step tools answer with after a write. */
export const STEP_UPDATE_SUCCESS =
  "Updated steps. FOLLOW and update your step list as you progress.";

/** Injected at the start of a turn when the session has steps worth reviewing. */
export const STEP_REVIEW_PROMPT =
  "Before anything else, review your current step list (<current_steps>...</current_steps> above):" +
  "\n- Are there steps that are now completed? Mark them done." +
  "\n- Are there steps that are stale or no longer relevant? Cancel them." +
  "\n- Are there any new steps implied by the current conversation that should be added?" +
  "\nAfter updating the list (if needed), continue working on the highest-priority pending or in-progress step.";

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
export function taskReminderMessage(
  text: string = STEP_REVIEW_PROMPT,
): AgentMessage {
  return {
    role: "user",
    content: `<system-reminder>\n${text}\n</system-reminder>`,
    timestamp: Date.now(),
  } as AgentMessage;
}

/** Render the live step list into the system prompt block. */
export function renderCurrentSteps(tasks: readonly Task[]): string {
  const marks: Record<TaskStatus, string> = {
    pending: "[ ]",
    in_progress: "[~]",
    completed: "[x]",
    cancelled: "[-]",
  };
  const body = tasks
    .map((t) => `${marks[t.status] ?? "[ ]"} ${t.id}: ${t.content}`)
    .join("\n");
  return `<current_steps>\n${body}\n</current_steps>`;
}
