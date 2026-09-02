//! Todo (current-tasks) prompt guidance.

// The `<current_tasks>` behavior (mark in_progress / tick off / cancel / skip
// trivial) is folded into `DEFAULT_SYSTEM_PROMPT`, not duplicated here.

/// Success reminder returned by the `update_todos` tool.
pub const TODO_UPDATE_SUCCESS: &str =
    "Updated TODOs. FOLLOW and update your TODO list as you progress.";
