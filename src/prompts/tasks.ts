/**
 * Todo prompts (verbatim port of todo.rs).
 */

/** Success reminder returned by the todo/state tools after a write. */
export const TASK_UPDATE_SUCCESS = "Updated TODOs. FOLLOW and update your TODO list as you progress.";

/** Auto-injected at the start of a turn when persisted todos exist. */
export const TASK_REVIEW_PROMPT =
	"Before anything else, review your current task list (<current_tasks>...</current_tasks> above):" +
	"\n- Are there tasks that are now completed? Mark them done." +
	"\n- Are there tasks that are stale or no longer relevant? Cancel them." +
	"\n- Are there any new tasks implied by the current conversation that should be added?" +
	"\nAfter updating the list (if needed), continue working on the highest-priority pending or in-progress item.";
