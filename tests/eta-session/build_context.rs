//! `build_context`: replay + compaction.

use eta_core::{SessionEntry, entry_kind};
use eta_session::build_context;

fn msg_entry(id: u64, kind: &str, role: &str, text: &str) -> SessionEntry {
    SessionEntry {
        id,
        kind: kind.to_string(),
        data: serde_json::json!({ "role": role, "content": text }),
    }
}

fn compaction_entry(id: u64, summary: &str, first_kept: u64) -> SessionEntry {
    SessionEntry {
        id,
        kind: entry_kind::COMPACTION.to_string(),
        data: serde_json::json!({ "summary": summary, "first_kept_entry_id": first_kept }),
    }
}

#[test]
fn replays_messages_without_compaction() {
    let entries = vec![
        msg_entry(0, entry_kind::USER_MESSAGE, "user", "hi"),
        msg_entry(1, entry_kind::ASSISTANT_MESSAGE, "assistant", "hello"),
    ];
    let ctx = build_context(&entries, "sys", &[]);
    assert_eq!(ctx.messages.len(), 2);
    assert_eq!(ctx.system_prompt.as_deref(), Some("sys"));
}

#[test]
fn compaction_inserts_summary_and_skips_prefix() {
    let entries = vec![
        msg_entry(0, entry_kind::USER_MESSAGE, "user", "old"),
        msg_entry(1, entry_kind::ASSISTANT_MESSAGE, "assistant", "old reply"),
        compaction_entry(2, "the summary", 3),
        msg_entry(3, entry_kind::USER_MESSAGE, "user", "new"),
        msg_entry(4, entry_kind::ASSISTANT_MESSAGE, "assistant", "new reply"),
    ];
    let ctx = build_context(&entries, "sys", &[]);
    assert_eq!(ctx.messages.len(), 3);
    assert!(ctx.messages[0].to_string().contains("the summary"));
    assert!(ctx.messages[1].to_string().contains("new"));
    assert!(ctx.messages[2].to_string().contains("new reply"));
}

#[test]
fn skips_non_message_entries() {
    let entries = vec![
        msg_entry(0, entry_kind::USER_MESSAGE, "user", "hi"),
        SessionEntry {
            id: 1,
            kind: entry_kind::USAGE.to_string(),
            data: serde_json::json!({ "input": 10 }),
        },
        SessionEntry {
            id: 2,
            kind: entry_kind::TURN.to_string(),
            data: serde_json::json!({ "request_id": "r" }),
        },
        msg_entry(3, entry_kind::ASSISTANT_MESSAGE, "assistant", "hello"),
    ];
    let ctx = build_context(&entries, "sys", &[]);
    assert_eq!(ctx.messages.len(), 2);
}
