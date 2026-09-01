//! Centralized system prompts and prompt fragments for the eta agent SDK.
//!
//! All prompt text lives here so it can be reviewed, tuned, and versioned in
//! one place instead of being scattered across the engine.

mod goal;
mod resume;
mod summary;

pub use goal::{goal_evaluator_prompt, goal_pursuit_guidelines};
pub use resume::{RESUME, RESUME_EMPTY, RESUME_LOOP, RESUME_TRUNCATED};
pub use summary::{
    SUMMARIZE_REQUEST, SUMMARIZE_SHORTER_RETRY, SUMMARIZE_SYSTEM_PROMPT, previous_summary,
};
