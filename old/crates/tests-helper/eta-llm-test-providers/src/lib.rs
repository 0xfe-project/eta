#![doc = include_str!("../README.md")]

use std::pin::Pin;

use eta_llm::{Context, Event, Model, Provider, ProviderError, Usage};
use tokio_stream::Stream;

fn stream_of(
    items: Vec<Result<Event, ProviderError>>,
) -> Pin<Box<dyn Stream<Item = Result<Event, ProviderError>> + Send>> {
    Box::pin(tokio_stream::iter(items))
}

fn content(text: &str) -> Event {
    Event::Content(serde_json::json!({ "type": "text", "text": text }))
}

// ── Setup errors (surfaced as an immediate Err item) ────────────────────────

pub struct ModelNotFoundErrorLLMProvider;
impl Provider for ModelNotFoundErrorLLMProvider {
    fn stream(
        &self,
        model: &Model,
        _: &Context,
        _: Option<&serde_json::Value>,
    ) -> Pin<Box<dyn Stream<Item = Result<Event, ProviderError>> + Send>> {
        stream_of(vec![Err(ProviderError::ModelNotFound(model.id.clone()))])
    }
}

pub struct AuthenticationErrorLLMProvider;
impl Provider for AuthenticationErrorLLMProvider {
    fn stream(
        &self,
        _: &Model,
        _: &Context,
        _: Option<&serde_json::Value>,
    ) -> Pin<Box<dyn Stream<Item = Result<Event, ProviderError>> + Send>> {
        stream_of(vec![Err(ProviderError::Authentication(
            "invalid api key".into(),
        ))])
    }
}

pub struct InvalidRequestErrorLLMProvider;
impl Provider for InvalidRequestErrorLLMProvider {
    fn stream(
        &self,
        _: &Model,
        _: &Context,
        _: Option<&serde_json::Value>,
    ) -> Pin<Box<dyn Stream<Item = Result<Event, ProviderError>> + Send>> {
        stream_of(vec![Err(ProviderError::InvalidRequest(
            "empty messages".into(),
        ))])
    }
}

pub struct RateLimitErrorLLMProvider;
impl Provider for RateLimitErrorLLMProvider {
    fn stream(
        &self,
        _: &Model,
        _: &Context,
        _: Option<&serde_json::Value>,
    ) -> Pin<Box<dyn Stream<Item = Result<Event, ProviderError>> + Send>> {
        stream_of(vec![Err(ProviderError::RateLimit)])
    }
}

pub struct UnavailableErrorLLMProvider;
impl Provider for UnavailableErrorLLMProvider {
    fn stream(
        &self,
        _: &Model,
        _: &Context,
        _: Option<&serde_json::Value>,
    ) -> Pin<Box<dyn Stream<Item = Result<Event, ProviderError>> + Send>> {
        stream_of(vec![Err(ProviderError::Unavailable)])
    }
}

pub struct TimeoutErrorLLMProvider;
impl Provider for TimeoutErrorLLMProvider {
    fn stream(
        &self,
        _: &Model,
        _: &Context,
        _: Option<&serde_json::Value>,
    ) -> Pin<Box<dyn Stream<Item = Result<Event, ProviderError>> + Send>> {
        stream_of(vec![Err(ProviderError::Timeout)])
    }
}

// ── Stream-time edge cases ───────────────────────────────────────────────────

/// Yields no events at all (stream ends immediately).
pub struct EmptyStreamLLMProvider;
impl Provider for EmptyStreamLLMProvider {
    fn stream(
        &self,
        _: &Model,
        _: &Context,
        _: Option<&serde_json::Value>,
    ) -> Pin<Box<dyn Stream<Item = Result<Event, ProviderError>> + Send>> {
        stream_of(vec![])
    }
}

/// Yields some `Content`, then terminates without `End` (mid-stream failure).
pub struct TruncatedStreamLLMProvider;
impl Provider for TruncatedStreamLLMProvider {
    fn stream(
        &self,
        _: &Model,
        _: &Context,
        _: Option<&serde_json::Value>,
    ) -> Pin<Box<dyn Stream<Item = Result<Event, ProviderError>> + Send>> {
        stream_of(vec![Ok(content("partial output"))])
    }
}

/// Yields `Content` + `ToolCall`, but never emits `End`.
pub struct MissingEndLLMProvider;
impl Provider for MissingEndLLMProvider {
    fn stream(
        &self,
        _: &Model,
        _: &Context,
        _: Option<&serde_json::Value>,
    ) -> Pin<Box<dyn Stream<Item = Result<Event, ProviderError>> + Send>> {
        stream_of(vec![
            Ok(content("hello")),
            Ok(Event::ToolCall {
                id: "call_1".into(),
                name: "read".into(),
                arguments: serde_json::json!({}),
            }),
        ])
    }
}

/// Emits a tool call whose arguments are not a JSON object (malformed).
pub struct MalformedToolCallLLMProvider;
impl Provider for MalformedToolCallLLMProvider {
    fn stream(
        &self,
        _: &Model,
        _: &Context,
        _: Option<&serde_json::Value>,
    ) -> Pin<Box<dyn Stream<Item = Result<Event, ProviderError>> + Send>> {
        stream_of(vec![
            Ok(Event::ToolCall {
                id: "call_2".into(),
                name: "read".into(),
                arguments: serde_json::json!("not-an-object"),
            }),
            Ok(Event::End {
                usage: Usage::default(),
                stop: eta_llm::StopReason::EndTurn,
            }),
        ])
    }
}
