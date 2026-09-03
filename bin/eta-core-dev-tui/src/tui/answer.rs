//! Pure rendering of `AgentEvent` and `ask_user` into display text.
//!
//! These functions are deliberately free of terminal state so they can be
//! unit-tested without a TTY; the answer panel buffers their output later.

use eta_core::{AgentEvent, AgentId};
use ratatui::style::Color;

/// Render one engine event as a single display line. `None` means the event
/// carries no visible content (for example a start/end envelope with no text).
/// Wired into the answer panel in E2/E8; kept `pub` here for unit tests.
#[allow(dead_code)]
pub fn event_line(agent_id: &AgentId, event: &AgentEvent) -> Option<String> {
    match event {
        AgentEvent::TurnStart { request_id } => Some(format!("── turn {request_id} ──")),
        AgentEvent::TurnEnd { request_id } => Some(format!("── end {request_id} ──")),
        AgentEvent::MessageStart { .. } | AgentEvent::MessageEnd { .. } => None,
        AgentEvent::MessageUpdate {
            agent_id: _,
            message,
        } => message
            .get("text")
            .and_then(|text| text.as_str())
            .map(|text| text.to_string()),
        AgentEvent::ToolExecutionStart { id, name, args } => {
            Some(format!("⚙ {name}({args}) [{id}]"))
        }
        AgentEvent::ToolExecutionEnd {
            id,
            result,
            is_error,
        } => {
            let marker = if *is_error { "✗" } else { "✓" };
            Some(format!("{marker} {id} → {result}"))
        }
        AgentEvent::GoalStateChange { status } => Some(format!("goal: {status:?}")),
        AgentEvent::Compaction { tokens_before } => {
            Some(format!("compacted ({tokens_before} tokens before)"))
        }
        AgentEvent::LoopDetected => Some("loop detected".to_string()),
        AgentEvent::AskUserStarted { req_id, question } => Some(render_ask_user(req_id, question)),
        AgentEvent::AgentEnd => Some(format!("agent {agent_id} ended")),
        AgentEvent::ReasoningUpdate { text, .. } => {
            let first_line = text.lines().next().unwrap_or_default();
            let preview: String = first_line.chars().take(80).collect();
            let ellipsis = if first_line.chars().count() > 80 {
                "…"
            } else {
                ""
            };
            Some(format!("💭 thinking: {preview}{ellipsis}"))
        }
        AgentEvent::Custom(value) => Some(format!("custom: {value}")),
    }
}

/// Stable per-agent color, derived from the agent id so the same agent keeps the
/// same color across sessions without any registry.
#[allow(dead_code)]
pub fn agent_color(agent_id: &AgentId) -> Color {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    const PALETTE: [Color; 8] = [
        Color::Cyan,
        Color::Green,
        Color::Yellow,
        Color::Magenta,
        Color::Blue,
        Color::LightGreen,
        Color::LightCyan,
        Color::LightMagenta,
    ];
    let mut hasher = DefaultHasher::new();
    agent_id.to_string().hash(&mut hasher);
    PALETTE[hasher.finish() as usize % PALETTE.len()]
}

/// Render an `ask_user` question as an inline popup-style block of text.
#[allow(dead_code)]
pub fn render_ask_user(req_id: &str, question: &serde_json::Value) -> String {
    let text = question
        .get("question")
        .and_then(|value| value.as_str())
        .unwrap_or("(no question)");
    let kind = question
        .get("kind")
        .and_then(|value| value.as_str())
        .unwrap_or("single");
    let mut out = format!("[ask_user {req_id}] ({kind}) {text}");
    if let Some(options) = question.get("options").and_then(|value| value.as_array()) {
        let rendered = options
            .iter()
            .filter_map(|option| option.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        if !rendered.is_empty() {
            out.push_str("\n  options: ");
            out.push_str(&rendered);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{agent_color, event_line, render_ask_user};
    use eta_core::{AgentEvent, AgentId, GoalStatus};

    #[test]
    fn renders_text_deltas_and_ignores_envelopes() {
        let id = AgentId("bob".into());
        let delta = AgentEvent::MessageUpdate {
            agent_id: id.clone(),
            message: serde_json::json!({ "type": "text", "text": "hello" }),
        };
        assert_eq!(event_line(&id, &delta).as_deref(), Some("hello"));
        assert_eq!(
            event_line(
                &id,
                &AgentEvent::MessageStart {
                    agent_id: id.clone(),
                    message: serde_json::json!({})
                }
            ),
            None
        );
    }

    #[test]
    fn renders_tools_and_goal_changes() {
        let id = AgentId("bob".into());
        assert_eq!(
            event_line(
                &id,
                &AgentEvent::ToolExecutionStart {
                    id: "c1".into(),
                    name: "bash".into(),
                    args: serde_json::json!({"command": "pwd"}),
                }
            )
            .as_deref(),
            Some("⚙ bash({\"command\":\"pwd\"}) [c1]")
        );
        assert_eq!(
            event_line(
                &id,
                &AgentEvent::GoalStateChange {
                    status: GoalStatus::Paused,
                }
            )
            .as_deref(),
            Some("goal: Paused")
        );
    }

    #[test]
    fn renders_ask_user_options() {
        let text = render_ask_user(
            "r1",
            &serde_json::json!({
                "question": "pick one",
                "kind": "single",
                "options": ["a", "b"]
            }),
        );
        assert!(text.contains("[ask_user r1] (single) pick one"));
        assert!(text.contains("options: a, b"));
    }

    #[test]
    fn agent_color_is_stable_for_the_same_id() {
        let id = AgentId("alice".into());
        assert_eq!(agent_color(&id), agent_color(&id));
        let other = AgentId("bob".into());
        let _ = agent_color(&other);
    }
}
