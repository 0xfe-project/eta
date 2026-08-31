#![doc = include_str!("../README.md")]

use std::pin::Pin;

use tokio_stream::Stream;
use serde::{Deserialize, Serialize};

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
    pub system_prompt: Option<String>,
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

/// A streamed event from the provider.
#[derive(Clone, Debug)]
pub enum Event {
    Content(serde_json::Value),
    ToolCall {
        name: String,
        arguments: serde_json::Value,
    },
    End {
        usage: Usage,
    },
}

/// A streaming provider. Implementations translate their native wire format
/// into the SDK's `Event` stream.
pub trait Provider: Send + Sync {
    fn stream(
        &self,
        model: &str,
        context: &Context,
        opts: Option<&serde_json::Value>,
    ) -> Result<Pin<Box<dyn Stream<Item = Event> + Send>>, ProviderError>;
}

/// Measures UTF-8 bytes per second over recorded text deltas.
#[derive(Debug)]
pub struct ThroughputMeter {
    bytes: u64,
    start: Option<std::time::Instant>,
}

impl Default for ThroughputMeter {
    fn default() -> Self {
        Self::new()
    }
}

impl ThroughputMeter {
    pub fn new() -> Self {
        Self {
            bytes: 0,
            start: None,
        }
    }

    pub fn record(&mut self, text: &str) {
        if self.start.is_none() {
            self.start = Some(std::time::Instant::now());
        }
        self.bytes += text.len() as u64;
    }

    pub fn utf8_per_sec(&self) -> f64 {
        let Some(start) = self.start else {
            return 0.0;
        };
        let secs = start.elapsed().as_secs_f64();
        if secs <= 0.0 {
            return 0.0;
        }
        self.bytes as f64 / secs
    }
}
