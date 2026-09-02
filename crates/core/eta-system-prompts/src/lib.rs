//! Centralized system prompts and prompt fragments for the eta agent SDK.
//!
//! All prompt text lives here so it can be reviewed, tuned, and versioned in
//! one place instead of being scattered across the engine.

mod evo;
mod goal;
mod resume;
mod skill;
mod summary;
mod todo;

pub use evo::{EVO_SIGNOFF_REMINDER, MEMORY_GUIDANCE};
pub use goal::{goal_evaluator_prompt, goal_pursuit_guidelines};
pub use resume::{RESUME, RESUME_EMPTY, RESUME_LOOP, RESUME_TRUNCATED};
pub use skill::SKILL_GUIDANCE;
pub use summary::{
    SUMMARIZE_REQUEST, SUMMARIZE_SHORTER_RETRY, SUMMARIZE_SYSTEM_PROMPT, UNTRUSTED_SUMMARY_NOTE,
    previous_summary,
};
pub use todo::{CURRENT_TASKS_GUIDANCE, TODO_UPDATE_SUCCESS};
