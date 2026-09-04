#![doc = include_str!("../README.md")]

use eta_llm::{Context, Event, Model, Provider, ProviderError, StopReason, Usage};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::pin::Pin;
use tokio::sync::mpsc;
use tokio_stream::{Stream, wrappers::ReceiverStream};

/// Anthropic Messages API streaming provider.
#[derive(Clone)]
pub struct AnthropicProvider {
    client: reqwest::Client,
    api_key: Option<String>,
    base_url: String,
}

impl AnthropicProvider {
    pub fn new(api_key: Option<String>, base_url: impl Into<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_key,
            base_url: base_url.into(),
        }
    }
    pub fn from_env() -> Self {
        Self::new(
            std::env::var("ANTHROPIC_API_KEY").ok(),
            std::env::var("ANTHROPIC_BASE_URL")
                .unwrap_or_else(|_| "https://api.anthropic.com".into()),
        )
    }
}

/// Map a reasoning effort label onto an Anthropic thinking token budget.
fn effort_to_budget(effort: &str) -> Option<u64> {
    match effort {
        "low" => Some(1_024),
        "medium" => Some(4_096),
        "high" => Some(16_384),
        _ => None,
    }
}

/// Mark a message's last cacheable content block with an ephemeral
/// cache_control breakpoint. Plain string content is upgraded to block form.
/// Mirrors crabcode's `mark_message_cache_breakpoint`.
fn mark_cache_breakpoint(message: &mut Value) -> bool {
    let Some(obj) = message.as_object_mut() else {
        return false;
    };
    if let Some(Value::String(text)) = obj.get("content").cloned() {
        obj.insert(
            "content".to_string(),
            json!([{ "type": "text", "text": text, "cache_control": { "type": "ephemeral" } }]),
        );
        return true;
    }
    let Some(blocks) = obj.get_mut("content").and_then(|c| c.as_array_mut()) else {
        return false;
    };
    for block in blocks.iter_mut().rev() {
        let Some(block_obj) = block.as_object_mut() else {
            continue;
        };
        let block_type = block_obj.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if block_type == "thinking" || block_type == "redacted_thinking" {
            continue;
        }
        block_obj.insert("cache_control".to_string(), json!({ "type": "ephemeral" }));
        return true;
    }
    false
}

impl Provider for AnthropicProvider {
    fn stream(
        &self,
        model: &Model,
        context: &Context,
        opts: Option<&Value>,
    ) -> Pin<Box<dyn Stream<Item = Result<Event, ProviderError>> + Send>> {
        let (tx, rx) = mpsc::channel(32);
        let client = self.client.clone();
        let key = self.api_key.clone();
        let url = format!("{}/v1/messages", self.base_url.trim_end_matches('/'));
        let model = model.clone();
        let context = context.clone();
        let opts = opts.cloned();
        tokio::spawn(async move {
            let mut body = json!({"model": model.id, "messages": context.messages, "stream": true, "max_tokens": model.max_tokens.unwrap_or(1024)});
            if let Some(system) =
                join_system_prompts(&context.system_prompt, &context.adapter_system_prompt)
            {
                // Prompt caching: the system prompt is the most stable prefix
                // (crabcode marks it the same way). Block form so the
                // breakpoint has somewhere to live.
                body["system"] = json!([{
                    "type": "text",
                    "text": system,
                    "cache_control": { "type": "ephemeral" }
                }]);
            }
            // Mark the last cacheable message block so conversation prefixes
            // hit the prompt cache across turns.
            if let Some(messages) = body["messages"].as_array_mut() {
                for message in messages.iter_mut().rev() {
                    if mark_cache_breakpoint(message) {
                        break;
                    }
                }
            }
            if !context.tools.is_empty() {
                body["tools"] = json!(context.tools.iter().map(|t| json!({"name":t.name,"description":t.description,"input_schema":t.schema})).collect::<Vec<_>>());
            }
            if let Some(extra) = opts {
                if let (Some(dst), Some(src)) = (body.as_object_mut(), extra.as_object()) {
                    for (k, v) in src {
                        // Anthropic spells reasoning as a thinking budget.
                        if k == "reasoning_effort" {
                            if let Some(budget) = effort_to_budget(v.as_str().unwrap_or("")) {
                                dst.insert(
                                    "thinking".to_string(),
                                    json!({"type": "enabled", "budget_tokens": budget}),
                                );
                            }
                            continue;
                        }
                        dst.insert(k.clone(), v.clone());
                    }
                }
            }
            let mut req = client
                .post(url)
                .header("anthropic-version", "2023-06-01")
                .json(&body);
            if let Some(key) = key {
                req = req.header("x-api-key", key);
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
            let mut usage = Usage::default();
            let mut stop = StopReason::EndTurn;
            let mut tool_id = None;
            let mut tool_name = String::new();
            let mut tool_json = String::new();
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
                    let Ok(v) =
                        serde_json::from_str::<Value>(line.trim_start_matches("data:").trim())
                    else {
                        continue;
                    };
                    match v.get("type").and_then(Value::as_str) {
                        Some("content_block_delta") => {
                            if let Some(delta) = v.get("delta") {
                                let delta_type =
                                    delta.get("type").and_then(Value::as_str).unwrap_or("");
                                if delta_type == "thinking_delta" {
                                    if let Some(thinking) =
                                        delta.get("thinking").and_then(Value::as_str)
                                    {
                                        if !thinking.is_empty() {
                                            if tx
                                                .send(Ok(Event::Content(
                                                    json!({"type":"text","text":thinking,"reasoning":true}),
                                                )))
                                                .await
                                                .is_err()
                                            {
                                                return;
                                            }
                                        }
                                    }
                                } else if let Some(text) = delta.get("text").and_then(Value::as_str)
                                {
                                    if tx
                                        .send(Ok(Event::Content(
                                            json!({"type":"text","text":text}),
                                        )))
                                        .await
                                        .is_err()
                                    {
                                        return;
                                    }
                                }
                                if let Some(partial) =
                                    delta.get("partial_json").and_then(Value::as_str)
                                {
                                    tool_json.push_str(partial);
                                }
                            }
                        }
                        Some("content_block_start") => {
                            if let Some(content) = v.get("content_block") {
                                if content.get("type").and_then(Value::as_str) == Some("tool_use") {
                                    tool_id =
                                        content.get("id").and_then(Value::as_str).map(String::from);
                                    tool_name = content
                                        .get("name")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .into();
                                    stop = StopReason::ToolUse;
                                }
                            }
                        }
                        Some("message_delta") => {
                            if let Some(reason) = v
                                .get("delta")
                                .and_then(|d| d.get("stop_reason"))
                                .and_then(Value::as_str)
                            {
                                stop = if reason == "max_tokens" {
                                    StopReason::MaxTokens
                                } else if reason == "tool_use" {
                                    StopReason::ToolUse
                                } else {
                                    StopReason::EndTurn
                                };
                            }
                        }
                        Some("message_start") => {
                            if let Some(u) = v.get("message").and_then(|m| m.get("usage")) {
                                usage.input =
                                    u.get("input_tokens").and_then(Value::as_u64).unwrap_or(0);
                            }
                        }
                        Some("message_stop") => {}
                        _ => {}
                    }
                }
            }
            if let Some(id) = tool_id {
                let arguments =
                    serde_json::from_str(&tool_json).unwrap_or_else(|_| json!({"raw":tool_json}));
                let _ = tx
                    .send(Ok(Event::ToolCall {
                        id,
                        name: tool_name,
                        arguments,
                    }))
                    .await;
            }
            let _ = tx.send(Ok(Event::End { usage, stop })).await;
        });
        Box::pin(ReceiverStream::new(rx))
    }
}

/// Combine the engine prompt and the client adapter prompt into Anthropic's
/// single `system` string while keeping the two slots distinct in `Context`.
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

pub type ProviderAnthropic = AnthropicProvider;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effort_maps_to_thinking_budget() {
        assert_eq!(effort_to_budget("low"), Some(1_024));
        assert_eq!(effort_to_budget("medium"), Some(4_096));
        assert_eq!(effort_to_budget("high"), Some(16_384));
        assert_eq!(effort_to_budget("bogus"), None);
    }

    #[test]
    fn string_content_upgrades_to_cached_block() {
        let mut message = json!({"role": "user", "content": "hello"});
        assert!(mark_cache_breakpoint(&mut message));
        assert_eq!(
            message["content"][0]["cache_control"],
            json!({"type": "ephemeral"})
        );
    }

    #[test]
    fn thinking_blocks_are_skipped_for_breakpoints() {
        let mut message = json!({
            "role": "assistant",
            "content": [
                {"type": "text", "text": "answer"},
                {"type": "thinking", "thinking": "..."}
            ]
        });
        assert!(mark_cache_breakpoint(&mut message));
        assert_eq!(
            message["content"][0]["cache_control"],
            json!({"type": "ephemeral"})
        );
        assert!(message["content"][1].get("cache_control").is_none());
    }
}
