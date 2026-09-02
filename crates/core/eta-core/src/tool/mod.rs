//! The `Tool` trait + builtin tools.

mod evo;
mod skill;
mod state;
mod todo;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;

use crate::error::ToolError;

/// A cloneable cancellation token handed to tool execution.
#[derive(Clone, Debug, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// A named tool the model can invoke.
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn schema(&self) -> serde_json::Value;
    fn requires_approval(&self) -> bool {
        false
    }
    async fn execute(
        &self,
        input: serde_json::Value,
        cancel: CancelToken,
    ) -> Result<serde_json::Value, ToolError>;
}

/// Validate tool arguments against the tool's input JSON Schema.
///
/// Returns `Err(message)` when the arguments are invalid so the engine can feed
/// the error back to the model.
pub(crate) fn validate_args(
    schema: &serde_json::Value,
    args: &serde_json::Value,
) -> Result<(), String> {
    let validator =
        jsonschema::Validator::new(schema).map_err(|e| format!("invalid tool schema: {e}"))?;
    if validator.is_valid(args) {
        Ok(())
    } else {
        let errors = validator
            .iter_errors(args)
            .map(|e| e.to_string())
            .collect::<Vec<_>>()
            .join("; ");
        Err(format!("invalid arguments: {errors}"))
    }
}

pub use evo::render_memory;
pub(crate) use evo::{builtin_evo_tool, load_memory};
pub use skill::render_skills;
pub(crate) use skill::{builtin_skill_tool, load_skills};
pub(crate) use state::builtin_state_tools;
pub use todo::render_todos;
pub(crate) use todo::{builtin_todo_tool, load_todos};
