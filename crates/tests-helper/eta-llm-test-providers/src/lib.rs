#![doc = include_str!("../README.md")]

use std::pin::Pin;

use eta_llm::{Context, Event, Provider, ProviderError, Usage};
use tokio_stream::Stream;

fn stream_of(events: Vec<Event>) -> Pin<Box<dyn Stream<Item = Event> + Send>> {
    Box::pin(tokio_stream::iter(events))
}

fn content(text: &str) -> Event {
    Event::Content(serde_json::json!({ "type": "text", "text": text }))
}

// ── Setup errors (returned from `stream`) ────────────────────────────────────

pub struct ModelNotFoundErrorLLMProvider;
impl Provider for ModelNotFoundErrorLLMProvider {
    fn stream(&self, model: &str, _: &Context, _: Option<&serde_json::Value>) -> Result<Pin<Box<dyn Stream<Item = Event> + Send>>, ProviderError> {
        Err(ProviderError::ModelNotFound(model.to_string()))
    }
}

pub struct AuthenticationErrorLLMProvider;
impl Provider for AuthenticationErrorLLMProvider {
    fn stream(&self, _: &str, _: &Context, _: Option<&serde_json::Value>) -> Result<Pin<Box<dyn Stream<Item = Event> + Send>>, ProviderError> {
        Err(ProviderError::Authentication("invalid api key".into()))
    }
}

pub struct InvalidRequestErrorLLMProvider;
impl Provider for InvalidRequestErrorLLMProvider {
    fn stream(&self, _: &str, _: &Context, _: Option<&serde_json::Value>) -> Result<Pin<Box<dyn Stream<Item = Event> + Send>>, ProviderError> {
        Err(ProviderError::InvalidRequest("empty messages".into()))
    }
}

pub struct RateLimitErrorLLMProvider;
impl Provider for RateLimitErrorLLMProvider {
    fn stream(&self, _: &str, _: &Context, _: Option<&serde_json::Value>) -> Result<Pin<Box<dyn Stream<Item = Event> + Send>>, ProviderError> {
        Err(ProviderError::RateLimit)
    }
}

pub struct UnavailableErrorLLMProvider;
impl Provider for UnavailableErrorLLMProvider {
    fn stream(&self, _: &str, _: &Context, _: Option<&serde_json::Value>) -> Result<Pin<Box<dyn Stream<Item = Event> + Send>>, ProviderError> {
        Err(ProviderError::Unavailable)
    }
}

pub struct TimeoutErrorLLMProvider;
impl Provider for TimeoutErrorLLMProvider {
    fn stream(&self, _: &str, _: &Context, _: Option<&serde_json::Value>) -> Result<Pin<Box<dyn Stream<Item = Event> + Send>>, ProviderError> {
        Err(ProviderError::Timeout)
    }
}

// ── Stream-time edge cases ───────────────────────────────────────────────────

/// Yields no events at all (stream ends immediately).
pub struct EmptyStreamLLMProvider;
impl Provider for EmptyStreamLLMProvider {
    fn stream(&self, _: &str, _: &Context, _: Option<&serde_json::Value>) -> Result<Pin<Box<dyn Stream<Item = Event> + Send>>, ProviderError> {
        Ok(stream_of(vec![]))
    }
}

/// Yields some `Content`, then terminates without `End` (mid-stream failure).
pub struct TruncatedStreamLLMProvider;
impl Provider for TruncatedStreamLLMProvider {
    fn stream(&self, _: &str, _: &Context, _: Option<&serde_json::Value>) -> Result<Pin<Box<dyn Stream<Item = Event> + Send>>, ProviderError> {
        Ok(stream_of(vec![content("partial output")]))
    }
}

/// Yields `Content` + `ToolCall`, but never emits `End`.
pub struct MissingEndLLMProvider;
impl Provider for MissingEndLLMProvider {
    fn stream(&self, _: &str, _: &Context, _: Option<&serde_json::Value>) -> Result<Pin<Box<dyn Stream<Item = Event> + Send>>, ProviderError> {
        Ok(stream_of(vec![
            content("hello"),
            Event::ToolCall {
                name: "read".into(),
                arguments: serde_json::json!({}),
            },
        ]))
    }
}

/// Emits a tool call whose arguments are not a JSON object (malformed).
pub struct MalformedToolCallLLMProvider;
impl Provider for MalformedToolCallLLMProvider {
    fn stream(&self, _: &str, _: &Context, _: Option<&serde_json::Value>) -> Result<Pin<Box<dyn Stream<Item = Event> + Send>>, ProviderError> {
        Ok(stream_of(vec![
            Event::ToolCall {
                name: "read".into(),
                arguments: serde_json::json!("not-an-object"),
            },
            Event::End {
                usage: Usage::default(),
            },
        ]))
    }
}
