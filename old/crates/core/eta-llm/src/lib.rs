#![doc = include_str!("../README.md")]

use std::pin::Pin;

use serde::{Deserialize, Serialize};
use tokio_stream::Stream;

/// A provider streaming error.
#[derive(Debug, Clone, thiserror::Error)]
pub enum ProviderError {
    #[error("model not found: {0}")]
    ModelNotFound(String),
    #[error("authentication failed: {0}")]
    Authentication(String),
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("rate limited")]
    RateLimit,
    #[error("provider unavailable")]
    Unavailable,
    #[error("request timed out")]
    Timeout,
    #[error("{0}")]
    Other(String),
}

/// Tool schema: name + description + input JSON Schema.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    pub schema: serde_json::Value,
}

/// A provider request context.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Context {
    /// Engine-assembled system prompt (persona + role + memory + skills …).
    pub system_prompt: Option<String>,
    /// Client/adapter-injected system prompt, kept separate so an embedder can
    /// add its own tool list, environment notes, or host-specific conventions
    /// without rewriting the engine's stable block.
    pub adapter_system_prompt: Option<String>,
    pub messages: Vec<serde_json::Value>,
    pub tools: Vec<ToolSchema>,
}

/// Token / cache accounting reported at the end of a stream.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Usage {
    /// Cache hit rate: `cache_read / (input + cache_read)`.
    ///
    /// `0.0` when there is no input at all; `1.0` when everything was a cache hit.
    pub fn cache_rate(&self) -> f64 {
        let total = self.input + self.cache_read;
        if total == 0 {
            0.0
        } else {
            self.cache_read as f64 / total as f64
        }
    }
}

/// A model descriptor. A bare `&str` / `String` is only a convenience entry
/// point; `core` uses `Model` to carry api / provider selection.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Model {
    pub id: String,
    pub label: Option<String>,
    pub api: Option<String>,
    pub base_url: Option<String>,
    pub reasoning: Option<bool>,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
    pub cost: Option<serde_json::Value>,
    /// Per-model wire extras merged into every request body (e.g.
    /// `reasoning_effort`, `thinking`). Provider-specific; merged shallowly,
    /// explicit call-site options win.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_options: Option<serde_json::Value>,
}

impl Model {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            label: None,
            api: None,
            base_url: None,
            reasoning: None,
            context_window: None,
            max_tokens: None,
            cost: None,
            request_options: None,
        }
    }
}

impl From<&str> for Model {
    fn from(id: &str) -> Self {
        Model::new(id)
    }
}

impl From<String> for Model {
    fn from(id: String) -> Self {
        Model::new(id)
    }
}

/// Why a stream ended. Drives retry decisions without guessing:
/// truncation = `MaxTokens`, empty response = `EndTurn` with no Content/ToolCall,
/// mid-stream error = `Error`, model used a tool = `ToolUse`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    Error,
    ToolUse,
}

/// A streamed event from the provider.
#[derive(Clone, Debug)]
pub enum Event {
    Content(serde_json::Value),
    ToolCall {
        id: String,
        name: String,
        arguments: serde_json::Value,
    },
    End {
        usage: Usage,
        stop: StopReason,
    },
}

/// A streaming provider. Implementations translate their native wire format
/// into the SDK's `Event` stream.
///
/// `Item = Result` so mid-stream errors (rate limit / network / API) surface as
/// `Err` and can be retried; a stream that fails to even start (model not found)
/// yields a single immediate `Err` item.
pub trait Provider: Send + Sync {
    fn stream(
        &self,
        model: &Model,
        context: &Context,
        opts: Option<&serde_json::Value>,
    ) -> Pin<Box<dyn Stream<Item = Result<Event, ProviderError>> + Send>>;
}
