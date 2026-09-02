//! Memory helpers: pure edit-merge + `<memory>` rendering.
//!
//! Memory is written out-of-band by the engine at the end of a turn; the agent
//! never calls an `evo`-style tool and is not told how memory is managed.
//! Persistence goes through the `MemoryStore` seam trait (see `store.rs`).

use std::collections::BTreeMap;

use crate::error::ToolError;
use crate::types::{MemoryEntry, MemoryKind};

/// Memory size cap in chars: beyond this, `add` fails until entries are removed.
pub const MEMORY_MAX_CHARS: usize = 20_000;

/// Apply a memory edit to an in-memory map (remove ids, then add decisions /
/// preferences / lessons). Returns the new total char count. Fails when the
/// addition would blow the cap (so the caller can retry with a smaller set).
///
/// Pure — used by `MemoryStore` impls (e.g. the SQLite backend) to share the
/// edit/merge/cap logic.
pub fn apply_memory_edits(
    memory: &mut BTreeMap<u64, MemoryEntry>,
    input: &serde_json::Value,
) -> Result<usize, ToolError> {
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
