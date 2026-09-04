//! Session view projection: turn the engine event streams into a plain-data
//! snapshot any frontend (TUI, web, GUI) can render without knowing
//! `AgentEvent` internals.
//!
//! The projector owns the streaming-text coalescing, the "empty turn" hint,
//! goal tracking, and the per-poll context snapshot (usage / prompts /
//! memory / skills / todos). Frontends push the resulting lines into their
//! own buffers.

use serde::{Deserialize, Serialize};

use eta_core::{AgentDevEvent, AgentEvent, TodoItem, dev_category};
use eta_llm::Usage;

use crate::SessionHandle;

/// Goal state shown in the status line / goal panel.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoalState {
    pub status: String,
    pub objective: String,
    pub round: u64,
}

impl GoalState {
    /// `goal: <status> <objective> · round <n>`, or `goal: —` when no goal.
    pub fn status_line(&self) -> String {
        if self.objective.is_empty() {
            "goal: —".to_string()
        } else {
            format!(
                "goal: {} {} · round {}",
                self.status, self.objective, self.round
            )
        }
    }
}

/// A plain-data snapshot of one session's context panel. Serializable so a
/// remote frontend can receive it verbatim.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SessionViewState {
    pub session_id: String,
    pub branch: String,
    pub stable_prompt: String,
    pub adaptive_prompt: String,
    pub tools: Vec<String>,
    pub goal: String,
    pub todos: Vec<String>,
    pub memory: Vec<String>,
    pub skills: Vec<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cache_rate: f64,
    /// Whether the engine is mid-turn (drives "working" indicators and the
    /// Enter-as-steer behavior).
    pub working: bool,
    /// Set while an `ask_user` question awaits an answer.
    pub pending_ask: Option<String>,
}

/// One poll's worth of increments produced by [`SessionProjection::poll`].
#[derive(Clone, Debug, Default)]
pub struct ViewUpdate {
    /// Answer-panel lines (coalesced streaming text, tool lines, markers).
    pub answer_lines: Vec<String>,
    /// Dev events seen since the last poll (raw; rendering is the client's).
    pub dev_events: Vec<AgentDevEvent>,
    /// Latest goal state, if a goal change was observed.
    pub goal: Option<GoalState>,
    /// Fresh context snapshot for the session.
    pub context: SessionViewState,
}

/// Per-session projector. One per attached session; cheap to keep around
/// for background sessions too.
#[derive(Default)]
pub struct SessionProjection {
    streaming: String,
    saw_text: bool,
    goal: Option<GoalState>,
    working: bool,
    pending_ask: Option<String>,
}

impl SessionProjection {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether the engine is currently mid-turn.
    pub fn working(&self) -> bool {
        self.working
    }

    /// The pending ask_user request id, if any.
    pub fn pending_ask(&self) -> Option<&str> {
        self.pending_ask.as_deref()
    }

    /// Drain engine events and refresh the snapshot from the handle.
    pub async fn poll(&mut self, handle: &mut SessionHandle) -> ViewUpdate {
        let mut update = ViewUpdate::default();

        if let Some(events) = handle.event_rx.as_mut() {
            while let Ok(event) = events.try_recv() {
                self.apply_event(handle.meta.agent_id.clone(), event, &mut update);
            }
        }
        self.flush_streaming(&mut update);

        if let Some(dev_events) = handle.dev_rx.as_mut() {
            while let Ok(event) = dev_events.try_recv() {
                if event.category == dev_category::GOAL && event.action == "change" {
                    let goal = GoalState {
                        status: event
                            .data
                            .get("status")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        objective: event
                            .data
                            .get("objective")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        round: event
                            .data
                            .get("round_count")
                            .and_then(|v| v.as_u64())
                            .unwrap_or_default(),
                    };
                    self.goal = Some(goal.clone());
                    update.goal = Some(goal);
                }
                update.dev_events.push(event);
            }
        }

        let usage: Usage = handle.agent.as_ref().map(|a| a.usage()).unwrap_or_default();
        let mut context = SessionViewState {
            session_id: handle.meta.id.clone(),
            branch: "main".to_string(),
            tools: handle.tool_names.clone(),
            goal: self
                .goal
                .as_ref()
                .map(|g| g.status_line())
                .unwrap_or_default(),
            input_tokens: usage.input,
            output_tokens: usage.output,
            cache_read: usage.cache_read,
            cache_write: usage.cache_write,
            cache_rate: usage.cache_rate(),
            working: self.working,
            pending_ask: self.pending_ask.clone(),
            ..Default::default()
        };
        if let Some(agent) = handle.agent.as_ref() {
            context.memory = agent.memory_entries().await;
            context.skills = agent.skill_names().await;
            context.stable_prompt = agent.stable_prompt().to_string();
            context.adaptive_prompt = agent.adaptive_prompt().to_string();
        }
        if let Some(value) = handle.store.get_state("eta.todos").await {
            if let Ok(items) = serde_json::from_value::<Vec<TodoItem>>(value) {
                context.todos = items
                    .iter()
                    .map(|item| {
                        format!(
                            "- {} [{}]",
                            item.content,
                            format!("{:?}", item.status).to_lowercase()
                        )
                    })
                    .collect();
            }
        }
        update.context = context;
        update
    }

    fn apply_event(
        &mut self,
        agent_id: eta_core::AgentId,
        event: AgentEvent,
        update: &mut ViewUpdate,
    ) {
        match &event {
            AgentEvent::TurnStart { .. } => {
                self.working = true;
                self.saw_text = false;
            }
            AgentEvent::TurnEnd { .. } => {
                self.working = false;
            }
            AgentEvent::AskUserStarted { req_id, .. } => {
                self.pending_ask = Some(req_id.clone());
            }
            AgentEvent::MessageUpdate { message, .. } => {
                if let Some(text) = message.get("text").and_then(|t| t.as_str()) {
                    if !text.is_empty() {
                        self.streaming.push_str(text);
                        self.saw_text = true;
                        return;
                    }
                }
            }
            _ => {}
        }
        // Any non-text event breaks the streaming run: flush first so lines
        // stay in order.
        self.flush_streaming(update);
        if matches!(&event, AgentEvent::TurnEnd { .. }) && !self.saw_text {
            update.answer_lines.push(
                "(no assistant text this turn — check model/provider or dev events)".to_string(),
            );
        }
        if let Some(line) = event_line(&agent_id, &event) {
            update.answer_lines.push(line);
        }
    }

    fn flush_streaming(&mut self, update: &mut ViewUpdate) {
        if !self.streaming.is_empty() {
            update
                .answer_lines
                .push(std::mem::take(&mut self.streaming));
        }
    }
}

/// Render one engine event as a single display line. `None` means the event
/// carries no visible content (start/end envelopes, message frames).
///
/// Lives in the controller so every frontend formats events identically.
pub fn event_line(agent_id: &eta_core::AgentId, event: &AgentEvent) -> Option<String> {
    match event {
        AgentEvent::TurnStart { request_id } => Some(format!("── turn {request_id} ──")),
        AgentEvent::TurnEnd { request_id } => Some(format!("── end {request_id} ──")),
        AgentEvent::MessageStart { .. } | AgentEvent::MessageEnd { .. } => None,
        AgentEvent::MessageUpdate { message, .. } => message
            .get("text")
            .and_then(|text| text.as_str())
            .map(|text| text.to_string()),
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
        AgentEvent::AskUserStarted { req_id, question } => Some(format!("? [{req_id}] {question}")),
        AgentEvent::AgentEnd => Some(format!("agent {agent_id} ended")),
        AgentEvent::Custom(value) => Some(format!("custom: {value}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eta_core::AgentId;
    use serde_json::json;

    #[test]
    fn streaming_text_coalesces_into_one_line() {
        let mut proj = SessionProjection::new();
        let mut update = ViewUpdate::default();
        let id = AgentId("a".into());
        for chunk in ["hel", "lo", " world"] {
            proj.apply_event(
                id.clone(),
                AgentEvent::MessageUpdate {
                    agent_id: id.clone(),
                    message: json!({"text": chunk}),
                },
                &mut update,
            );
        }
        assert!(update.answer_lines.is_empty());
        proj.flush_streaming(&mut update);
        assert_eq!(update.answer_lines, vec!["hello world".to_string()]);
    }

    #[test]
    fn tool_event_flushes_streaming_first() {
        let mut proj = SessionProjection::new();
        let mut update = ViewUpdate::default();
        let id = AgentId("a".into());
        proj.apply_event(
            id.clone(),
            AgentEvent::MessageUpdate {
                agent_id: id.clone(),
                message: json!({"text": "reading file…"}),
            },
            &mut update,
        );
        proj.apply_event(
            id.clone(),
            AgentEvent::ToolExecutionStart {
                id: "t1".into(),
                name: "read".into(),
                args: json!({}),
            },
            &mut update,
        );
        assert_eq!(update.answer_lines.len(), 2);
        assert_eq!(update.answer_lines[0], "reading file…");
        assert!(update.answer_lines[1].starts_with("⚙ read"));
    }

    #[test]
    fn empty_turn_gets_a_hint() {
        let mut proj = SessionProjection::new();
        let mut update = ViewUpdate::default();
        let id = AgentId("a".into());
        proj.apply_event(
            id.clone(),
            AgentEvent::TurnStart {
                request_id: "r1".into(),
            },
            &mut update,
        );
        proj.apply_event(
            id,
            AgentEvent::TurnEnd {
                request_id: "r1".into(),
            },
            &mut update,
        );
        assert!(
            update
                .answer_lines
                .iter()
                .any(|l| l.contains("no assistant text"))
        );
    }

    #[test]
    fn working_flag_tracks_turn_lifecycle() {
        let mut proj = SessionProjection::new();
        let mut update = ViewUpdate::default();
        let id = AgentId("a".into());
        assert!(!proj.working());
        proj.apply_event(
            id.clone(),
            AgentEvent::TurnStart {
                request_id: "r1".into(),
            },
            &mut update,
        );
        assert!(proj.working());
        proj.apply_event(
            id,
            AgentEvent::TurnEnd {
                request_id: "r1".into(),
            },
            &mut update,
        );
        assert!(!proj.working());
    }

    #[test]
    fn ask_user_marks_pending() {
        let mut proj = SessionProjection::new();
        let mut update = ViewUpdate::default();
        let id = AgentId("a".into());
        proj.apply_event(
            id,
            AgentEvent::AskUserStarted {
                req_id: "ask-1".into(),
                question: "continue?".into(),
            },
            &mut update,
        );
        assert_eq!(proj.pending_ask(), Some("ask-1"));
    }

    #[test]
    fn goal_state_status_line() {
        let goal = GoalState {
            status: "active".into(),
            objective: "ship it".into(),
            round: 3,
        };
        assert_eq!(goal.status_line(), "goal: active ship it · round 3");
        assert_eq!(GoalState::default().status_line(), "goal: —");
    }

    #[test]
    fn reasoning_update_renders_folded_preview() {
        let line = event_line(
            &AgentId("a".into()),
            &AgentEvent::ReasoningUpdate {
                agent_id: AgentId("a".into()),
                text: "let me think about this\nin detail".into(),
            },
        )
        .unwrap();
        assert!(line.starts_with("💭 thinking: let me think about this"));
    }
}
