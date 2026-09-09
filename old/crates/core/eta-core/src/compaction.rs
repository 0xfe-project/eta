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

/// Max-min-fair character allocations across messages (grok-bot
/// `computeMaxMinFairAllocations`): sort ascending, give each `min(size,
/// fair_share)`, redistributing leftover from small messages.
pub fn max_min_fair_allocations(sizes: &[usize], budget: usize) -> Vec<usize> {
    let n = sizes.len();
    if n == 0 {
        return vec![];
    }
    let mut allocs = vec![0usize; n];
    let mut indices: Vec<usize> = (0..n).collect();
    indices.sort_by_key(|&i| sizes[i]);
    let mut remaining = budget;
    let mut count = n;
    for &i in &indices {
        let fair = remaining / count;
        let take = fair.min(sizes[i]);
        allocs[i] = take;
        remaining -= take;
        count -= 1;
    }
    allocs
}

/// Deterministic fallback when the LLM summarizer fails: max-min-fair truncate
/// the messages to `char_budget`. Messages too small to keep a useful chunk are
/// replaced by an omission note. Returns `None` if nothing useful fits.
pub fn truncate_fairly(messages: &[serde_json::Value], char_budget: usize) -> Option<String> {
    const MIN_USEFUL_CHARS: usize = 200;
    let serialized: Vec<String> = messages.iter().map(|m| m.to_string()).collect();
    let sizes: Vec<usize> = serialized.iter().map(|s| s.chars().count()).collect();
    let allocs = max_min_fair_allocations(&sizes, char_budget);

    let mut parts = Vec::new();
    let mut kept = 0;
    for (i, msg) in serialized.iter().enumerate() {
        let size = sizes[i];
        let alloc = allocs[i];
        if alloc >= size {
            parts.push(msg.clone());
            kept += 1;
        } else if alloc < MIN_USEFUL_CHARS {
            parts.push(format!("[omitted message, {size} chars]"));
        } else {
            let truncated: String = msg.chars().take(alloc).collect();
            parts.push(format!("{truncated}\n[... truncated, {size} chars]"));
            kept += 1;
        }
    }
    if kept == 0 {
        return None;
    }
    Some(parts.join("\n\n"))
}

/// Reduce the summarization prompt budget on input-too-large (grok-bot
/// `reducePromptBudget`): `/2` on the first reduction, `/3` after, capped at
/// 75% of the original length, and never below `min`.
pub fn reduce_budget(current: usize, attempt: usize, original_len: usize, min: usize) -> usize {
    let divisor = if attempt >= 2 { 3 } else { 2 };
    let mut next = current / divisor;
    next = next.min(original_len * 3 / 4);
    next.max(min)
}
