//! Todo (current-tasks) prompt guidance.

// The `<current_tasks>` behavior (mark in_progress / tick off / cancel / skip
// trivial) is folded into `DEFAULT_SYSTEM_PROMPT`, not duplicated here.

/// Success reminder returned by the `update_todos` tool.
pub const TODO_UPDATE_SUCCESS: &str =
    "Updated TODOs. FOLLOW and update your TODO list as you progress.";

/// Auto-injected at the start of a turn when persisted todos exist.
///
/// Asks the agent to audit the list (new items? completed? stale?) before
/// doing anything else, then continue the user's work in order.
pub const TODO_REVIEW_PROMPT: &str = "Before anything else, review your current task list (<current_tasks>...</current_tasks> above):\
\n- Are there tasks that are now completed? Mark them done.\
\n- Are there tasks that are stale or no longer relevant? Cancel them.\
\n- Are there any new tasks implied by the current conversation that should be added?\
\nAfter updating the list (if needed), continue working on the highest-priority pending or in-progress item.";
