//! Memory storage helpers for the `eta.memory` session key.
//!
//! Memory is written out-of-band by the engine at the end of a turn; the agent
//! never calls an `evo`-style tool and is not told how memory is managed.

use std::collections::BTreeMap;

use crate::error::ToolError;
use crate::store::SessionStorage;
use crate::types::{MemoryEntry, MemoryKind};

/// Storage key for the persisted memory.
const MEMORY_KEY: &str = "eta.memory";

/// Memory size cap in chars: beyond this, `add` fails until entries are removed.
pub(crate) const MEMORY_MAX_CHARS: usize = 20_000;

/// Load the memory from session state (empty when absent or malformed).
pub(crate) async fn load_memory(store: &dyn SessionStorage) -> BTreeMap<u64, MemoryEntry> {
    store
        .get_state(MEMORY_KEY)
        .await
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// Apply a memory edit (remove ids, then add decisions / preferences / lessons)
/// to the store. Shared by the turn-end extraction. Returns the new total char
/// count. Fails when the addition would blow the cap (so the caller can retry
/// with a smaller set).
pub(crate) async fn apply_memory_edits(
    store: &dyn SessionStorage,
    input: &serde_json::Value,
) -> Result<usize, ToolError> {
    let mut memory = load_memory(store).await;

    // Remove ids first (always allowed).
    if let Some(ids) = input.get("remove_memory_ids").and_then(|v| v.as_array()) {
        for id in ids {
            if let Some(n) = id.as_u64() {
                memory.remove(&n);
            }
        }
    }

    // Collect new entries.
    let mut additions: Vec<(MemoryKind, String)> = Vec::new();
    for (kind, key) in [
        (MemoryKind::Decision, "add_new_decision"),
        (MemoryKind::Preference, "add_new_preference"),
        (MemoryKind::Lesson, "learn_new_lesson"),
    ] {
        if let Some(items) = input.get(key).and_then(|v| v.as_array()) {
            for item in items {
                if let Some(s) = item.as_str() {
                    if !s.trim().is_empty() {
                        additions.push((kind, s.to_string()));
                    }
                }
            }
        }
    }

    // Cap check: `add` fails when the total would exceed the cap.
    let current: usize = memory.values().map(|e| e.content.chars().count()).sum();
    let incoming: usize = additions.iter().map(|(_, s)| s.chars().count()).sum();
    let total = current + incoming;
    if total > MEMORY_MAX_CHARS {
        return Err(ToolError::Execution(format!(
            "memory would exceed {MEMORY_MAX_CHARS} chars (would be {total})"
        )));
    }

    // Add.
    let mut next_id = memory.keys().max().copied().unwrap_or(0) + 1;
    for (kind, content) in additions {
        memory.insert(next_id, MemoryEntry { kind, content });
        next_id += 1;
    }

    store.set_state(MEMORY_KEY, serde_json::json!(memory)).await;

    Ok(total)
}

fn kind_str(kind: MemoryKind) -> &'static str {
    match kind {
        MemoryKind::Decision => "decision",
        MemoryKind::Preference => "preference",
        MemoryKind::Lesson => "lesson",
    }
}

/// Render the `<memory>` durable block from the memory map.
pub fn render_memory(memory: &BTreeMap<u64, MemoryEntry>) -> String {
    if memory.is_empty() {
        return String::new();
    }
    let body = memory
        .iter()
        .map(|(_, e)| format!("- [{}] {}", kind_str(e.kind), e.content))
        .collect::<Vec<_>>()
        .join("\n");
    format!("<memory>\n{body}\n</memory>")
}
