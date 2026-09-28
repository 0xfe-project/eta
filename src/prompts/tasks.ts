/**
 * Task prompts (verbatim port of eta-agent's `prompts/tasks.ts`, itself a port
 * of todo.rs).
 *
 * Model-visible text lives here rather than in the tools that return it: the
 * prompts module owns the words, so a deployment can review what its agent says
 * in one place. (The full assembler — platform rules, memory, skills — is the
 * next slice; this is the part the task tools need today.)
 */

/** What the task tools answer with after a write. */
export const TASK_UPDATE_SUCCESS = "Updated TODOs. FOLLOW and update your TODO list as you progress.";

/** Injected at the start of a turn when the session has tasks worth reviewing. */
export const TASK_REVIEW_PROMPT =
	"Before anything else, review your current task list (<current_tasks>...</current_tasks> above):" +
	"\n- Are there tasks that are now completed? Mark them done." +
	"\n- Are there tasks that are stale or no longer relevant? Cancel them." +
	"\n- Are there any new tasks implied by the current conversation that should be added?" +
	"\nAfter updating the list (if needed), continue working on the highest-priority pending or in-progress item.";
