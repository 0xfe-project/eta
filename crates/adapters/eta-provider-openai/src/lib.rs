#![doc = include_str!("../README.md")]

use eta_llm::{Context, Event, Model, Provider, ProviderError, StopReason, Usage};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::pin::Pin;
use tokio::sync::mpsc;
use tokio_stream::{Stream, wrappers::ReceiverStream};

/// OpenAI-compatible Chat Completions provider.
#[derive(Clone)]
pub struct OpenAiProvider {
    client: reqwest::Client,
    api_key: Option<String>,
    base_url: String,
}

impl OpenAiProvider {
    pub fn new(api_key: Option<String>, base_url: impl Into<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_key,
            base_url: base_url.into(),
        }
    }
    pub fn from_env() -> Self {
        Self::new(
            std::env::var("OPENAI_API_KEY").ok(),
            std::env::var("OPENAI_BASE_URL").unwrap_or_else(|_| "https://api.openai.com/v1".into()),
        )
    }
}

impl Provider for OpenAiProvider {
    fn stream(
        &self,
        model: &Model,
        context: &Context,
        opts: Option<&Value>,
    ) -> Pin<Box<dyn Stream<Item = Result<Event, ProviderError>> + Send>> {
        let (tx, rx) = mpsc::channel(32);
        let client = self.client.clone();
        let key = self.api_key.clone();
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let model = model.clone();
        let context = context.clone();
        let opts = opts.cloned();
        tokio::spawn(async move {
            let mut messages = Vec::new();
            let system =
                join_system_prompts(&context.system_prompt, &context.adapter_system_prompt);
            if let Some(system) = system {
                messages.push(json!({"role":"system","content":system}));
            }
            messages.extend(context.messages.clone());
            let mut body = json!({"model": model.id, "messages": messages, "stream": true});
            if !context.tools.is_empty() {
                body["tools"] = json!(context.tools.iter().map(|t| json!({"type":"function","function":{"name":t.name,"description":t.description,"parameters":t.schema}})).collect::<Vec<_>>());
            }
            if let Some(extra) = opts {
                if let (Some(dst), Some(src)) = (body.as_object_mut(), extra.as_object()) {
                    for (k, v) in src {
                        dst.insert(k.clone(), v.clone());
                    }
                }
            }
            let mut req = client.post(url).json(&body);
            if let Some(key) = key {
                req = req.bearer_auth(key);
            }
            let response = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    let _ = tx.send(Err(ProviderError::Other(e.to_string()))).await;
                    return;
                }
            };
            if !response.status().is_success() {
                let _ = tx.send(Err(map_status(response.status()))).await;
                return;
            }
            let mut stream = response.bytes_stream();
            let mut buffer = String::new();
            let mut tool_calls: std::collections::BTreeMap<usize, (String, String, String)> =
                Default::default();
            let mut usage = Usage::default();
            let mut stop = StopReason::EndTurn;
            while let Some(chunk) = stream.next().await {
                let bytes = match chunk {
                    Ok(b) => b,
                    Err(e) => {
                        let _ = tx.send(Err(ProviderError::Other(e.to_string()))).await;
                        return;
                    }
                };
                buffer.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(pos) = buffer.find('\n') {
                    let line = buffer.drain(..=pos).collect::<String>();
                    let line = line.trim();
                    if !line.starts_with("data:") {
                        continue;
                    }
                    let data = line.trim_start_matches("data:").trim();
                    if data == "[DONE]" {
                        continue;
                    }
                    let Ok(value) = serde_json::from_str::<Value>(data) else {
                        continue;
                    };
                    if let Some(u) = value.get("usage") {
                        usage.input = u
                            .get("prompt_tokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(usage.input);
                        usage.output = u
                            .get("completion_tokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(usage.output);
                    }
                    let choice = value
                        .get("choices")
                        .and_then(|v| v.get(0))
                        .unwrap_or(&Value::Null);
                    if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                        stop = match reason {
                            "length" => StopReason::MaxTokens,
                            "tool_calls" => StopReason::ToolUse,
                            _ => StopReason::EndTurn,
                        };
                    }
                    let delta = choice.get("delta").unwrap_or(&Value::Null);
                    if let Some(text) = delta.get("content").and_then(Value::as_str) {
                        if tx
                            .send(Ok(Event::Content(json!({"type":"text","text":text}))))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                    // DeepSeek reasoning models stream their chain-of-thought
                    // separately. Preserve it as text while marking the block
                    // so consumers may hide it from the final answer UI.
                    if let Some(text) = delta.get("reasoning_content").and_then(Value::as_str) {
                        if !text.is_empty()
                            && tx
                                .send(Ok(Event::Content(
                                    json!({"type":"text","text":text,"reasoning":true}),
                                )))
                                .await
                                .is_err()
                        {
                            return;
                        }
                    }
                    if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                        for call in calls {
                            let idx =
                                call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                            let e = tool_calls.entry(idx).or_insert((
                                String::new(),
                                String::new(),
                                String::new(),
                            ));
                            if let Some(id) = call.get("id").and_then(Value::as_str) {
                                e.0 = id.into();
                            }
                            if let Some(name) = call
                                .get("function")
                                .and_then(|f| f.get("name"))
                                .and_then(Value::as_str)
                            {
                                e.1.push_str(name);
                            }
                            if let Some(args) = call
                                .get("function")
                                .and_then(|f| f.get("arguments"))
                                .and_then(Value::as_str)
                            {
                                e.2.push_str(args);
                            }
                        }
                    }
                }
            }
            for (_, (id, name, args)) in tool_calls {
                let arguments = serde_json::from_str(&args).unwrap_or_else(|_| json!({"raw":args}));
                if tx
                    .send(Ok(Event::ToolCall {
                        id,
                        name,
                        arguments,
                    }))
                    .await
                    .is_err()
                {
                    return;
                }
            }
            let _ = tx.send(Ok(Event::End { usage, stop })).await;
        });
        Box::pin(ReceiverStream::new(rx))
    }
}

/// Combine the engine prompt and the client adapter prompt into one system
/// message. Keeping them in separate `Context` slots preserves the boundary at
/// the SDK layer while remaining compatible with providers that expect a
/// single system message.
fn join_system_prompts(engine: &Option<String>, adapter: &Option<String>) -> Option<String> {
    match (engine, adapter) {
        (Some(engine), Some(adapter)) => Some(format!("{engine}\n\n{adapter}")),
        (Some(engine), None) => Some(engine.clone()),
        (None, Some(adapter)) => Some(adapter.clone()),
        (None, None) => None,
    }
}

fn map_status(status: reqwest::StatusCode) -> ProviderError {
    match status.as_u16() {
        401 | 403 => ProviderError::Authentication(status.to_string()),
        404 => ProviderError::ModelNotFound(status.to_string()),
        408 | 504 => ProviderError::Timeout,
        429 => ProviderError::RateLimit,
        400..=499 => ProviderError::InvalidRequest(status.to_string()),
        _ => ProviderError::Unavailable,
    }
}

pub type ProviderOpenAI = OpenAiProvider;

/// OpenAI Responses API provider (`POST /v1/responses`, streaming JSON SSE).
///
/// `providers/openai_responses.rs`; it translates the chat-style eta `Context`
/// into the Responses `input` item list and maps the Responses SSE events back
/// onto the SDK's `Event::{Content, ToolCall, End}`.
#[derive(Clone)]
pub struct ResponsesProvider {
    client: reqwest::Client,
    api_key: Option<String>,
    base_url: String,
}

impl ResponsesProvider {
    pub fn new(api_key: Option<String>, base_url: impl Into<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_key,
            base_url: base_url.into(),
        }
    }

    pub fn from_env() -> Self {
        Self::new(
            std::env::var("OPENAI_API_KEY").ok(),
            std::env::var("OPENAI_BASE_URL").unwrap_or_else(|_| "https://api.openai.com".into()),
        )
    }
}

impl Provider for ResponsesProvider {
    fn stream(
        &self,
        model: &Model,
        context: &Context,
        opts: Option<&Value>,
    ) -> Pin<Box<dyn Stream<Item = Result<Event, ProviderError>> + Send>> {
        let (tx, rx) = mpsc::channel(32);
        let client = self.client.clone();
        let key = self.api_key.clone();
        let url = responses_url(&self.base_url);
        let model = model.clone();
        let context = context.clone();
        let opts = opts.cloned();
        tokio::spawn(async move {
            let mut body = json!({
                "model": model.id,
                "input": responses_input(&context),
                "stream": true,
                "store": false,
            });
            if let Some(max) = model.max_tokens {
                body["max_output_tokens"] = json!(max);
            }
            if !context.tools.is_empty() {
                body["tools"] = json!(
                    context
                        .tools
                        .iter()
                        .map(|tool| json!({
                            "type": "function",
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.schema,
                        }))
                        .collect::<Vec<_>>()
                );
            }
            if let Some(extra) = opts {
                if let (Some(dst), Some(src)) = (body.as_object_mut(), extra.as_object()) {
                    for (k, v) in src {
                        dst.insert(k.clone(), v.clone());
                    }
                }
            }

            let mut req = client.post(url).json(&body);
            if let Some(key) = key {
                req = req.bearer_auth(key);
            }
            let response = match req.send().await {
                Ok(response) => response,
                Err(err) => {
                    let _ = tx.send(Err(ProviderError::Other(err.to_string()))).await;
                    return;
                }
            };
            if !response.status().is_success() {
                let _ = tx.send(Err(map_status(response.status()))).await;
                return;
            }

            let mut stream = response.bytes_stream();
            let mut buffer = String::new();
            let mut current_tool: Option<(String, String, String)> = None;
            let mut usage = Usage::default();
            let mut stop = StopReason::EndTurn;
            while let Some(chunk) = stream.next().await {
                let bytes = match chunk {
                    Ok(bytes) => bytes,
                    Err(err) => {
                        let _ = tx.send(Err(ProviderError::Other(err.to_string()))).await;
                        return;
                    }
                };
                buffer.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(pos) = buffer.find('\n') {
                    let line = buffer.drain(..=pos).collect::<String>();
                    let line = line.trim();
                    if !line.starts_with("data:") {
                        continue;
                    }
                    let data = line.trim_start_matches("data:").trim();
                    let Ok(value) = serde_json::from_str::<Value>(data) else {
                        continue;
                    };
                    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
                    match kind {
                        "response.output_item.added" => {
                            let item = value.get("item").unwrap_or(&Value::Null);
                            if item.get("type").and_then(Value::as_str) == Some("function_call") {
                                current_tool = Some((
                                    item.get("call_id")
                                        .and_then(Value::as_str)
                                        .unwrap_or("")
                                        .into(),
                                    item.get("name")
                                        .and_then(Value::as_str)
                                        .unwrap_or("")
                                        .into(),
                                    String::new(),
                                ));
                            }
                        }
                        "response.output_text.delta" => {
                            if let Some(text) = value.get("delta").and_then(Value::as_str) {
                                if tx
                                    .send(Ok(Event::Content(json!({"type":"text","text":text}))))
                                    .await
                                    .is_err()
                                {
                                    return;
                                }
                            }
                        }
                        "response.content_part.delta" => {
                            // Older OpenAI responses format, or third-party
                            // implementations (deepseek/unorouter) that emit this.
                            if let Some(text) = value.get("delta").and_then(Value::as_str) {
                                if tx
                                    .send(Ok(Event::Content(json!({"type":"text","text":text}))))
                                    .await
                                    .is_err()
                                {
                                    return;
                                }
                            }
                        }
                        "response.reasoning_summary_text.delta" => {
                            if let Some(text) = value.get("delta").and_then(Value::as_str) {
                                if tx
                                    .send(Ok(Event::Content(
                                        json!({"type":"text","text":text,"reasoning":true}),
                                    )))
                                    .await
                                    .is_err()
                                {
                                    return;
                                }
                            }
                        }
                        "response.content_part.delta"
                            if value.get("content_type") == Some(&json!("reasoning")) =>
                        {
                            if let Some(text) = value.get("delta").and_then(Value::as_str) {
                                if tx
                                    .send(Ok(Event::Content(
                                        json!({"type":"text","text":text,"reasoning":true}),
                                    )))
                                    .await
                                    .is_err()
                                {
                                    return;
                                }
                            }
                        }
                        "response.function_call_arguments.delta" => {
                            if let Some((_, _, arguments)) = current_tool.as_mut() {
                                if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                                    arguments.push_str(delta);
                                }
                            }
                        }
                        "response.function_call_arguments.done" => {
                            if let Some((id, name, mut arguments)) = current_tool.take() {
                                if let Some(final_arguments) =
                                    value.get("arguments").and_then(Value::as_str)
                                {
                                    arguments = final_arguments.to_string();
                                }
                                let arguments = serde_json::from_str::<Value>(&arguments)
                                    .unwrap_or_else(|_| json!({"raw": arguments}));
                                if tx
                                    .send(Ok(Event::ToolCall {
                                        id,
                                        name,
                                        arguments,
                                    }))
                                    .await
                                    .is_err()
                                {
                                    return;
                                }
                            }
                        }
                        "response.completed" => {
                            if let Some(response_usage) = value.pointer("/response/usage") {
                                usage.input = response_usage
                                    .get("input_tokens")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(usage.input);
                                usage.output = response_usage
                                    .get("output_tokens")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(usage.output);
                                usage.cache_read = response_usage
                                    .pointer("/input_tokens_details/cached_tokens")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(usage.cache_read);
                                usage.cache_write = response_usage
                                    .pointer("/input_tokens_details/cache_write_tokens")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(usage.cache_write);
                            }
                            stop = responses_stop_reason(&value);
                        }
                        "response.failed" | "response.error" | "error" => {
                            let message = value
                                .pointer("/error/message")
                                .or_else(|| value.pointer("/response/error/message"))
                                .and_then(Value::as_str)
                                .unwrap_or("openai-responses error");
                            let _ = tx
                                .send(Err(ProviderError::Other(message.to_string())))
                                .await;
                            return;
                        }
                        _ => {}
                    }
                }
            }
            let _ = tx.send(Ok(Event::End { usage, stop })).await;
        });
        Box::pin(ReceiverStream::new(rx))
    }
}

/// Normalize a base URL to exactly one `/v1` segment before `/responses`.
fn responses_url(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    if trimmed.ends_with("/v1") {
        format!("{trimmed}/responses")
    } else {
        format!("{trimmed}/v1/responses")
    }
}

/// Convert the chat-style eta `Context` into the Responses `input` item list.
fn responses_input(context: &Context) -> Vec<Value> {
    let mut input = Vec::new();
    if let Some(system) =
        join_system_prompts(&context.system_prompt, &context.adapter_system_prompt)
    {
        input.push(json!({
            "role": "system",
            "content": [{"type": "input_text", "text": system}],
        }));
    }
    for message in &context.messages {
        input.extend(responses_message(message));
    }
    input
}

fn responses_message(message: &Value) -> Vec<Value> {
    match message.get("role").and_then(Value::as_str).unwrap_or("") {
        "user" => {
            let text = message.get("content").and_then(Value::as_str).unwrap_or("");
            vec![json!({"role":"user","content":[{"type":"input_text","text":text}]})]
        }
        "assistant" => {
            let mut items = Vec::new();
            if let Some(content) = message.get("content").and_then(Value::as_str) {
                if !content.is_empty() {
                    items.push(json!({
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": content}],
                    }));
                }
            }
            if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
                for call in tool_calls {
                    items.push(json!({
                        "type": "function_call",
                        "call_id": call.get("id").and_then(Value::as_str).unwrap_or(""),
                        "name": call.get("function").and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or(""),
                        "arguments": call.get("function").and_then(|f| f.get("arguments")).and_then(Value::as_str).unwrap_or("{}"),
                    }));
                }
            }
            items
        }
        "tool" => {
            let call_id = message
                .get("tool_call_id")
                .and_then(Value::as_str)
                .unwrap_or("");
            let output = message.get("content").and_then(Value::as_str).unwrap_or("");
            vec![json!({
                "type": "function_call_output",
                "call_id": call_id,
                "output": output,
            })]
        }
        _ => Vec::new(),
    }
}

fn responses_stop_reason(payload: &Value) -> StopReason {
    if let Some(output) = payload
        .pointer("/response/output")
        .and_then(Value::as_array)
    {
        if output
            .iter()
            .any(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
        {
            return StopReason::ToolUse;
        }
    }
    match payload
        .pointer("/response/status")
        .and_then(Value::as_str)
        .unwrap_or("")
    {
        "incomplete" => StopReason::MaxTokens,
        _ => StopReason::EndTurn,
    }
}
