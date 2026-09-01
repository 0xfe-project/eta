//! Unified error types for the engine and the LLM layer.

use eta_llm::ProviderError;

/// A tool execution / validation error.
#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("validation failed: {0}")]
    Validation(String),
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("execution failed: {0}")]
    Execution(String),
    #[error("cancelled")]
    Cancelled,
    #[error("tool not found: {0}")]
    NotFound(String),
}

/// The four failure categories every error path collapses into.
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("retriable error: {message}")]
    Retriable { message: String },
    #[error("action required ({action}): {message}")]
    ActionRequired { action: String, message: String },
    #[error("non-retriable error: {message}")]
    NonRetriable { message: String },
    #[error("cancelled")]
    Cancelled,
}

impl AgentError {
    /// Whether the error is worth retrying.
    pub fn is_retryable(&self) -> bool {
        matches!(self, AgentError::Retriable { .. })
    }
}

/// Classify a provider error into one of the four categories.
pub fn classify_provider_error(e: &ProviderError) -> AgentError {
    match e {
        ProviderError::RateLimit | ProviderError::Unavailable | ProviderError::Timeout => {
            AgentError::Retriable {
                message: e.to_string(),
            }
        }
        ProviderError::Authentication(_) | ProviderError::ModelNotFound(_) => {
            AgentError::NonRetriable {
                message: e.to_string(),
            }
        }
        ProviderError::InvalidRequest(_) => AgentError::NonRetriable {
            message: e.to_string(),
        },
        ProviderError::Other(m) => AgentError::Retriable { message: m.clone() },
    }
}
