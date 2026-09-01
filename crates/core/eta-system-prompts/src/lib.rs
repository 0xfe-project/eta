//! Centralized system prompts and prompt fragments for the eta agent SDK.
//!
//! All prompt text lives here so it can be reviewed, tuned, and versioned in
//! one place instead of being scattered across the engine.

/// Summarizer system prompt (shared by mid-loop summarization and the
/// authoritative compaction).
pub const SUMMARIZE_PROMPT: &str = "Summarize the conversation so far, concisely.";

/// Goal evaluator: a tool-free call that judges whether the goal is achieved.
pub fn goal_evaluator_prompt(objective: &str) -> String {
    format!(
        "You judge whether a goal is achieved. Goal: \"{objective}\". \
         Based on the conversation, is the goal fully achieved? \
         Reply with exactly YES or NO."
    )
}

/// Guidelines injected into the context while an agent pursues a goal.
pub fn goal_pursuit_guidelines(objective: &str) -> String {
    format!("You are working toward the goal: {objective}. Keep pursuing it until it is done.")
}

/// Continuation reminders injected when the engine retries or recovers from a
/// stuck state.
pub const CONTINUATION_CONTINUE: &str = "[continuation] continue";
pub const CONTINUATION_TRUNCATED: &str =
    "[continuation] output was truncated, continue in smaller chunks";
pub const CONTINUATION_EMPTY: &str = "[continuation] no output produced, continue";
pub const CONTINUATION_LOOP: &str = "[continuation] detected a loop, try a different approach";

/// A summarized history block injected in place of the compressed prefix.
pub fn previous_summary(summary: &str) -> String {
    format!("[Previous conversation summary]\n{summary}")
}
