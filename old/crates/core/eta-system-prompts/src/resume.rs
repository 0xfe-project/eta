//! Resume / retry reminders injected when the engine recovers from a stuck state.

pub const RESUME: &str = "[resume] continue";
pub const RESUME_TRUNCATED: &str = "[resume] output was truncated, continue in smaller chunks";
pub const RESUME_EMPTY: &str = "[resume] no output produced, continue";
pub const RESUME_LOOP: &str = "[resume] detected a loop, try a different approach";
