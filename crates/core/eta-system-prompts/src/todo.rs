//! Todo (current-tasks) prompt guidance.

/// System-prompt guidance that makes the model RESPECT the todo list.
///
/// Without this the model treats the list as passive context; with it the model
/// keeps the plan current and works through it.
pub const CURRENT_TASKS_GUIDANCE: &str =
    "<current_tasks>...</current_tasks> is your plan. FOLLOW it:
- Mark a task in_progress before starting; completed when done.
- Update it when the plan changes (add / remove / reorder).
- Cancel tasks that no longer apply.
- Skip for trivial one-step work.";

/// Success reminder returned by the `update_todos` tool.
pub const TODO_UPDATE_SUCCESS: &str =
    "Updated TODOs. FOLLOW and update your TODO list as you progress.";
