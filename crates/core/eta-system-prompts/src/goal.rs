//! Goal-related prompts.

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
