//! Evo / memory prompts.

/// Memory guidance: how to use the `evo` tool to keep memory lean.
pub const MEMORY_GUIDANCE: &str = "Memory has 3 sections: decision (user's HARD requirements), preference (weaker), lesson (from failures + negative feedback). Before ending, call evo to finalize memory. Remove stale/merged entries as you add. Memory cap: 20000 chars — if over, add fails; remove junk first.";

/// Reminder injected when the agent would end without calling `evo`.
pub const EVO_SIGNOFF_REMINDER: &str =
    "You must call evo to finalize your memory before ending (even with empty args).";
