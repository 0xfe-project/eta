//! Goal-related prompts.

/// Goal evaluator: a tool-free call that judges whether the goal is achieved.
pub fn goal_evaluator_prompt(objective: &str) -> String {
    format!("Is the goal achieved? Goal: \"{objective}\". Reply YES or NO only.")
}

/// Guidelines injected into the context while an agent pursues a goal.
pub fn goal_pursuit_guidelines(objective: &str) -> String {
    format!("Working toward goal: {objective}. Keep going until done.")
}
