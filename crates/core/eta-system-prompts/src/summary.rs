//! Summarization-related prompts.

/// Summarizer system prompt (shared by mid-loop summarization and the
/// authoritative compaction).
pub const SUMMARIZE_PROMPT: &str = "Summarize the conversation so far, concisely.";

/// A summarized history block injected in place of the compressed prefix.
pub fn previous_summary(summary: &str) -> String {
    format!("[Previous conversation summary]\n{summary}")
}
