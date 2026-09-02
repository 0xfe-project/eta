//! Compaction: turn-boundary authoritative context compression.

use std::collections::HashSet;

use serde_json::Value;

/// Tool-message ratio (percent) above which tool noise is dropped from the prefix.
pub const TOOL_MESSAGE_DROP_THRESHOLD: usize = 25;

/// Rough token estimate (~4 chars per token).
pub fn estimate_tokens(messages: &[Value]) -> usize {
    messages.iter().map(|m| m.to_string().len() / 4 + 1).sum()
}

/// True when the context has grown past 80% of the window.
pub fn should_compact(messages: &[Value], window: usize) -> bool {
    window > 0 && estimate_tokens(messages) * 100 >= window * 80
}

fn is_user(msg: &Value) -> bool {
    msg.get("role").and_then(|r| r.as_str()) == Some("user")
}

fn is_tool_result(msg: &Value) -> bool {
    msg.get("role").and_then(|r| r.as_str()) == Some("tool")
}

/// Split messages into (prefix to summarize, suffix to keep). Walks backward,
/// accumulating tokens, and cuts at the most recent user message once
/// `keep_recent_tokens` is reached (the cut lands on a turn boundary).
pub fn partition(messages: &[Value], keep_recent_tokens: usize) -> (Vec<Value>, Vec<Value>) {
    let mut acc = 0usize;
    for i in (0..messages.len()).rev() {
        acc += messages[i].to_string().len() / 4 + 1;
        if is_user(&messages[i]) && acc >= keep_recent_tokens {
            return (messages[..i].to_vec(), messages[i..].to_vec());
        }
    }
    (Vec::new(), messages.to_vec())
}

/// Drop tool results (and their paired assistant tool calls, when present) from
/// the prefix, but only when the tool ratio is ≥ `TOOL_MESSAGE_DROP_THRESHOLD`.
/// A pair is dropped only if both halves are in the prefix — never a dangling
/// tool_use / tool_result.
pub fn drop_tool_pairs(messages: &[Value]) -> Vec<Value> {
    let tool_count = messages.iter().filter(|m| is_tool_result(m)).count();
    if messages.is_empty() || tool_count * 100 < messages.len() * TOOL_MESSAGE_DROP_THRESHOLD {
        return messages.to_vec();
    }

    let result_ids: HashSet<String> = messages
        .iter()
        .filter(|m| is_tool_result(m))
        .filter_map(|m| {
            m.get("tool_call_id")
                .and_then(|t| t.as_str())
                .map(String::from)
        })
        .collect();

    messages
        .iter()
        .filter(|m| {
            if is_tool_result(m) {
                return false;
            }
            if m.get("tool_calls").is_some() {
                if let Some(id) = m
                    .get("tool_calls")
                    .and_then(|c| c.get(0))
                    .and_then(|tc| tc.get("id"))
                    .and_then(|i| i.as_str())
                {
                    return !result_ids.contains(id);
                }
            }
            true
        })
        .cloned()
        .collect()
}
