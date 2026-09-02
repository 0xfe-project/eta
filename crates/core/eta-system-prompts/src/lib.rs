//! Centralized system prompts and prompt fragments for the eta agent SDK.
//!
//! All prompt text lives here so it can be reviewed, tuned, and versioned in
//! one place instead of being scattered across the engine.

mod base;
mod evo;
mod goal;
mod resume;
mod skill;
mod summary;
mod todo;

pub use base::DEFAULT_SYSTEM_PROMPT;
pub use evo::{MEMORY_EXTRACT_PROMPT, MEMORY_EXTRACT_SYSTEM_PROMPT};
pub use goal::{goal_evaluator_prompt, goal_pursuit_guidelines};
pub use resume::{RESUME, RESUME_EMPTY, RESUME_LOOP, RESUME_TRUNCATED};
pub use summary::{
    SUMMARIZE_REQUEST, SUMMARIZE_SHORTER_RETRY, SUMMARIZE_SYSTEM_PROMPT, UNTRUSTED_SUMMARY_NOTE,
    previous_summary,
};
pub use todo::TODO_UPDATE_SUCCESS;
