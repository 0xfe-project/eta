//! Application state and session/agent/model lifecycle for the dev TUI.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use crossterm::event::KeyCode;

use eta_core::{AgentInput, AskUserAnswer, SessionEntry, entry_kind};
use eta_core_controller::{
    self as controller, SessionManager, SpawnError, SpawnRequest, configured_model, load_config,
    model_entries, set_active_model,
};
use eta_sqlite_storage::SqliteSessionStore;
use serde_json::json;

use crate::commands::Command;
use crate::config;
use crate::tui;
use crate::tui::goal::GoalInfo;
use crate::tui::screen::{NewConversation, Screen};
use crate::tui::{ContextSnapshot, Focus};
use tui_textarea::TextArea;

/// A pending `ask_user` question waiting for the user's answer.
pub(crate) struct PendingAsk {
    pub(crate) req_id: String,
}

/// Per-session panel state, kept so attach switching restores each session's
/// own answer/dev/context/goal view.
#[derive(Default)]
pub(crate) struct SessionView {
    pub(crate) answers: Vec<String>,
    pub(crate) dev: Vec<String>,
    pub(crate) context: Option<ContextSnapshot>,
    pub(crate) goal: Option<GoalInfo>,
    pub(crate) tool_names: Vec<String>,
    pub(crate) answers_scroll: usize,
    pub(crate) context_scroll: usize,
    pub(crate) dev_scroll: usize,
}

/// Interactive UI state: current focus, input, the session registry, and the
/// rendered buffers for the three upper panels.
pub(crate) struct App {
    pub(crate) screen: Screen,
    pub(crate) focus: Focus,
    pub(crate) input: TextArea<'static>,
    pub(crate) sessions: SessionManager,
    pub(crate) sqlite: Option<Arc<SqliteSessionStore>>,
    pub(crate) head: Option<u64>,
    pub(crate) loop_counter: u64,
    views: HashMap<String, SessionView>,
    projectors: HashMap<String, controller::SessionProjection>,
    pub(crate) pending_ask: Option<PendingAsk>,
    pub(crate) dev_base: Instant,
    history: Vec<String>,
    history_idx: Option<usize>,
    pub(crate) dev_filter: String,
    pub(crate) dev_filtering: bool,
    pub(crate) current_model: String,
    pub(crate) working: bool,
}

impl App {
    pub(crate) fn new() -> Self {
        let mut input = TextArea::default();
        input.set_placeholder_text("type a message…");
        let recent =
            eta_sqlite_storage::list_sessions_in(&eta_fs::sessions_dir()).unwrap_or_default();
        Self {
            screen: Screen::startup(recent),
            focus: Focus::Input,
            input,
            sessions: SessionManager::new(),
            sqlite: None,
            head: None,
            loop_counter: 0,
            views: HashMap::new(),
            projectors: HashMap::new(),
            pending_ask: None,
            dev_base: Instant::now(),
            history: Vec::new(),
            history_idx: None,
            dev_filter: String::new(),
            dev_filtering: false,
            current_model: configured_model(&load_config()).unwrap_or_default(),
            working: false,
        }
    }

    /// The current session's panel view, creating it on first use.
    pub(crate) fn view(&mut self) -> &mut SessionView {
        let id = self.sessions.current_id().unwrap_or_default().to_string();
        self.views.entry(id).or_default()
    }

    /// Scroll the focused panel by `delta` rows (negative = up), clamped.
    pub(crate) fn scroll_panel(&mut self, panel: crate::tui::Focus, delta: i64) {
        let view = self.view();
        let len = match panel {
            crate::tui::Focus::Answers => view.answers.len(),
            crate::tui::Focus::DevEvents => view.dev.len(),
            crate::tui::Focus::Context => view
                .context
                .as_ref()
                .map(|snapshot| crate::tui::context::render_snapshot(snapshot, 8).len())
                .unwrap_or(0),
            crate::tui::Focus::Input => return,
        };
        let scroll = match panel {
            crate::tui::Focus::Answers => &mut view.answers_scroll,
            crate::tui::Focus::DevEvents => &mut view.dev_scroll,
            crate::tui::Focus::Context => &mut view.context_scroll,
            crate::tui::Focus::Input => return,
        };
        // Scrolling is by physical rows after wrapping, so a single logical line
        // can occupy many rows. Keep a generous upper bound and let ratatui's
        // `Paragraph::scroll` clamp to the actual content; only guard against
        // underflow on the low end.
        let upper = len.saturating_mul(16).max(1) as i64;
        *scroll = (*scroll as i64 + delta).clamp(0, upper) as usize;
    }

    /// Whether the input box is currently empty.
    pub(crate) fn input_is_empty(&self) -> bool {
        self.input.lines().iter().all(|line| line.is_empty())
    }

    /// Record a submitted line into prompt history (dedup of the last entry).
    pub(crate) fn push_history(&mut self, text: String) {
        let text = text.trim().to_string();
        if text.is_empty() {
            return;
        }
        if self.history.last() != Some(&text) {
            self.history.push(text);
        }
        self.history_idx = None;
    }

    /// Recall a previous prompt, setting the input box content to it.
    pub(crate) fn recall_history(&mut self, delta: i64) {
        if self.history.is_empty() {
            return;
        }
        let current = self.history_idx.unwrap_or(self.history.len());
        let next = (current as i64 + delta).clamp(0, self.history.len() as i64 - 1) as usize;
        self.history_idx = Some(next);
        let mut input = TextArea::default();
        input.insert_str(&self.history[next]);
        self.input = input;
    }

    /// One-line status for the bottom bar.
    pub(crate) fn status_line(&self) -> String {
        let mode = match self.screen {
            Screen::Session => "session",
            Screen::Startup { .. } => "startup",
            _ => "picker",
        };
        let session = shorten(self.sessions.current_id().unwrap_or("-"), 12);
        let agent = shorten(
            &self
                .sessions
                .current()
                .map(|handle| handle.meta.agent_id.0.clone())
                .unwrap_or_default(),
            12,
        );
        let model = shorten(&self.current_model, 24);
        let state = if self.working { "working…" } else { "idle" };
        format!("{mode} · {state} · session {session} · agent {agent} · model {model}")
    }

    pub(crate) fn start_dev_filter(&mut self) {
        self.dev_filter.clear();
        self.dev_filtering = true;
    }

    /// Feed one key into the dev-filter input; returns whether filtering is open.
    pub(crate) fn dev_filter_key(&mut self, key_code: KeyCode) -> bool {
        if !self.dev_filtering {
            return false;
        }
        match key_code {
            KeyCode::Esc | KeyCode::Enter => {
                self.dev_filtering = false;
            }
            KeyCode::Backspace => {
                self.dev_filter.pop();
            }
            KeyCode::Char(ch) => {
                self.dev_filter.push(ch);
            }
            _ => {}
        }
        self.dev_filtering
    }

    pub(crate) fn clear_dev(&mut self) {
        self.view().dev.clear();
    }

    /// `/<cmd>`-style completions based on the current input text.
    pub(crate) fn completions(&self) -> Vec<String> {
        let text = self.input.lines().join("\n").trim().to_string();
        if text.starts_with('/') {
            crate::commands::command_completions(&text)
                .into_iter()
                .map(|item| format!("{} — {}", item.usage, item.desc))
                .collect()
        } else {
            Vec::new()
        }
    }

    #[cfg(test)]
    pub(crate) fn with_sessions(sessions: SessionManager) -> Self {
        let mut app = Self::new();
        app.sessions = sessions;
        app.screen = Screen::session();
        app
    }

    /// Drain the current session's engine/dev streams into the panels and
    /// refresh the context snapshot from `Agent::usage()`.
    pub(crate) async fn pump(&mut self) {
        let Some(session_id) = self.sessions.current_id().map(String::from) else {
            return;
        };
        let mut projector = self.projectors.remove(&session_id).unwrap_or_default();
        let update = {
            let Some(handle) = self.sessions.current_mut() else {
                self.projectors.insert(session_id.clone(), projector);
                return;
            };
            projector.poll(handle).await
        };
        self.working = projector.working();
        if let Some(req_id) = projector.pending_ask() {
            self.pending_ask = Some(PendingAsk {
                req_id: req_id.to_string(),
            });
        }
        self.projectors.insert(session_id.clone(), projector);

        let dev_base = self.dev_base;
        let view = self.views.entry(session_id.clone()).or_default();
        view.answers.extend(update.answer_lines);
        view.dev.extend(
            update
                .dev_events
                .iter()
                .map(|event| tui::dev::dev_event_line(event, dev_base)),
        );
        if let Some(goal) = update.goal {
            view.goal = Some(GoalInfo {
                status: goal.status,
                objective: goal.objective,
                round: goal.round,
            });
        }
        let ctx = update.context;
        view.context = Some(ContextSnapshot {
            session_id,
            branch: ctx.branch,
            input_tokens: ctx.input_tokens,
            output_tokens: ctx.output_tokens,
            cache_read: ctx.cache_read,
            cache_write: ctx.cache_write,
            cache_rate: ctx.cache_rate,
            stable_prompt: ctx.stable_prompt,
            adaptive_prompt: ctx.adaptive_prompt,
            goal: ctx.goal,
            todos: ctx.todos,
            tools: ctx.tools,
            memory: ctx.memory,
            skills: ctx.skills,
            ..Default::default()
        });
    }

    /// Send the submitted line to the current session. While the agent is
    /// running, Enter acts as a steer (interrupt + inject) instead of queueing a
    /// second user message; otherwise it is a normal user message.
    pub(crate) async fn send_message(&mut self, text: &str) {
        let content = json!({ "type": "text", "text": text });
        let input = if self.working {
            AgentInput::Steer { message: content }
        } else {
            AgentInput::UserMessage { content }
        };
        self.send_input(input).await;
    }

    /// Send an engine input to the currently attached session.
    pub(crate) async fn send_input(&mut self, input: AgentInput) {
        let Some(handle) = self.sessions.current() else {
            return;
        };
        if let Some(agent) = handle.agent.as_ref() {
            let _ = agent.send(input).await;
        }
    }

    /// Interrupt the current turn without quitting.
    pub(crate) fn cancel_current(&self) {
        if let Some(agent) = self
            .sessions
            .current()
            .and_then(|handle| handle.agent.as_ref())
        {
            agent.cancel();
        }
    }

    /// Answer the pending `ask_user` question and resume the engine.
    pub(crate) async fn answer_ask_user(&mut self, answer: String) {
        let Some(pending) = self.pending_ask.take() else {
            return;
        };
        if let Some(agent) = self
            .sessions
            .current()
            .and_then(|handle| handle.agent.as_ref())
        {
            let _ = agent
                .answer(AskUserAnswer {
                    tool_call_id: pending.req_id,
                    answer: json!(answer),
                })
                .await;
        }
    }

    /// Apply a time-travel command against the concrete SQLite session store.
    pub(crate) fn apply_time_travel(&mut self, command: &Command) -> Option<String> {
        let sqlite = self.sqlite.as_ref()?;
        crate::session::apply_time_travel(sqlite, &mut self.head, command)
    }

    /// Register a cron loop on the current session and return its id.
    pub(crate) async fn register_loop(
        &mut self,
        schedule: String,
        prompt: String,
    ) -> Option<String> {
        self.loop_counter += 1;
        let loop_id = format!("loop-{}", self.loop_counter);
        let handle = self.sessions.current()?;
        handle
            .register_loop(&loop_id, schedule, prompt)
            .await
            .then_some(loop_id)
    }

    pub(crate) async fn list_loops(&mut self) -> Option<Vec<String>> {
        Some(self.sessions.current()?.list_loops().await)
    }

    pub(crate) async fn remove_loop(&mut self, loop_id: &str) -> Option<bool> {
        Some(self.sessions.current()?.remove_loop(loop_id).await)
    }

    /// Persist a per-session model override in session KV.
    pub(crate) async fn save_model(&mut self, model: &str) {
        if let Some(handle) = self.sessions.current() {
            let store = handle.store.clone();
            controller::save_model(store.as_ref(), model).await;
        }
    }

    pub(crate) fn model_catalog(&self) -> Vec<String> {
        model_entries(&load_config())
    }

    pub(crate) fn open_model_picker(&mut self) {
        let models = self.model_catalog();
        self.screen.open_model_picker(models);
    }

    pub(crate) async fn confirm_model_picker(&mut self) {
        let Some(model) = self.screen.confirm_model() else {
            return;
        };
        self.save_model(&model).await;
        // Persist the global default so the selection survives restarts.
        // The session KV above stays as a per-session override.
        let persisted = set_active_model(&model).is_ok();
        self.respawn_with_model(&model).await;
        self.screen = Screen::session();
        let scope = if persisted { "saved" } else { "session" };
        self.view()
            .answers
            .push(format!("model: {model} ({scope})"));
    }

    pub(crate) async fn respawn_with_model(&mut self, model_id: &str) {
        let Some(session) = self.sessions.current() else {
            return;
        };
        let session_id = session.meta.id.clone();
        let agent_name = session.meta.agent_id.0.clone();
        let store = session.store.clone();
        let Ok(plan) =
            controller::assemble_respawn(&session_id, &agent_name, model_id, store).await
        else {
            self.screen.open_model_picker(self.model_catalog());
            return;
        };
        self.current_model = plan.model.id.clone();
        let tool_names = plan.tool_names.clone();
        let handle = controller::spawn(plan);
        self.sessions.replace(handle);
        self.sessions.attach(&session_id);
        self.views.entry(session_id.clone()).or_default().tool_names = tool_names;
    }

    pub(crate) fn open_agent_switch(&mut self) {
        let agents = config::agent_names(eta_fs::agents_dir());
        self.screen.open_agent_switch(agents);
    }

    pub(crate) async fn open_session_picker(&mut self) {
        let current = self.sessions.current_id().map(String::from);
        let ids = self.sessions.ids();
        let mut sessions = Vec::new();
        for id in &ids {
            let preview = if let Some(handle) = self.sessions.get(id) {
                last_message_preview(&handle.store.load().await)
            } else {
                String::new()
            };
            if preview.is_empty() {
                sessions.push(id.clone());
            } else {
                sessions.push(format!("{id} - {preview}"));
            }
        }
        self.screen.open_session_picker(current, sessions, ids);
    }

    pub(crate) fn confirm_session_picker(&mut self) {
        let Some(id) = self.screen.confirm_session() else {
            return;
        };
        self.sessions.attach(&id);
        self.screen = Screen::session();
    }

    pub(crate) async fn switch_agent(&mut self, name: &str) {
        let Some(session) = self.sessions.current() else {
            return;
        };
        let session_id = session.meta.id.clone();
        let store = session.store.clone();
        let model_id = if self.current_model.is_empty() {
            let Some(model_id) = configured_model(&load_config()) else {
                self.open_model_picker();
                return;
            };
            model_id
        } else {
            self.current_model.clone()
        };
        let Ok(plan) = controller::assemble_respawn(&session_id, name, &model_id, store).await
        else {
            self.open_model_picker();
            return;
        };
        self.current_model = plan.model.id.clone();
        if let Some(old) = self.sessions.current().and_then(|s| s.agent.as_ref()) {
            old.cancel();
        }
        self.sessions.replace(controller::spawn(plan));
        self.sessions.attach(&session_id);
        self.view().answers.push(format!("agent: {name}"));
    }

    pub(crate) async fn confirm_agent_switch(&mut self) {
        let Some(name) = self.screen.confirm_agent_switch() else {
            return;
        };
        self.switch_agent(&name).await;
        self.screen = Screen::session();
    }

    pub(crate) fn persona_catalog(&self) -> Vec<String> {
        config::persona_names(eta_fs::persona_dir())
    }

    pub(crate) fn begin_agent_mode(&mut self) {
        self.screen.begin_agent_mode();
    }

    pub(crate) fn confirm_agent_mode(&mut self) {
        let agents = config::agent_names(eta_fs::agents_dir());
        self.screen.confirm_agent_mode(agents);
    }

    pub(crate) fn cancel_picker(&mut self) {
        self.screen = self.screen.clone().cancel();
    }

    pub(crate) async fn confirm_existing_agent(&mut self) {
        let Some(NewConversation::ExistingAgent { agent, draft }) = self.screen.confirm_agent()
        else {
            return;
        };
        self.spawn_session_for_agent(&agent, None).await;
        self.screen = Screen::session();
        self.send_message(&draft).await;
    }

    pub(crate) fn begin_persona_picker(&mut self) {
        let personas = self.persona_catalog();
        self.screen.begin_persona_picker(personas);
    }

    pub(crate) async fn confirm_new_agent(&mut self) {
        let Some(NewConversation::NewAgent {
            name,
            persona,
            draft,
        }) = self.screen.confirm()
        else {
            return;
        };
        self.spawn_session_for_agent(&name, Some(&persona)).await;
        self.screen = Screen::session();
        self.send_message(&draft).await;
    }

    pub(crate) async fn spawn_session_for_agent(&mut self, name: &str, persona: Option<&str>) {
        let request = SpawnRequest {
            agent_name: name.to_string(),
            persona: persona.map(String::from),
            model_id: None,
        };
        let plan = match controller::assemble_new(&request).await {
            Ok(plan) => plan,
            Err(SpawnError::NoModel) | Err(SpawnError::UnknownModel(_)) => {
                self.open_model_picker();
                return;
            }
        };
        let session_id = plan.session_id.clone();
        self.current_model = plan.model.id.clone();
        let tool_names = plan.tool_names.clone();
        self.sqlite = Some(plan.sqlite.clone());
        let handle = controller::spawn(plan);
        self.sessions.insert(handle);
        self.sessions.attach(&session_id);
        self.views.entry(session_id.clone()).or_default().tool_names = tool_names;
    }

    /// Open an existing session by id and spawn its agent, then attach it.
    pub(crate) async fn attach_existing_session(&mut self, session_id: &str) {
        if let Some(existing) = self.sessions.get(session_id) {
            if existing.is_spawned() {
                self.sessions.attach(session_id);
                self.screen = Screen::session();
                return;
            }
        }
        let Ok(plan) = controller::assemble_resume(session_id).await else {
            return;
        };
        let tool_names = plan.tool_names.clone();
        self.sqlite = Some(plan.sqlite.clone());
        let handle = controller::spawn(plan);
        if let Some(loop_manager) = handle.loop_manager.clone() {
            loop_manager.start().await;
        }
        self.sessions.insert(handle);
        self.sessions.attach(session_id);
        self.views
            .entry(session_id.to_string())
            .or_default()
            .tool_names = tool_names;
        self.screen = Screen::session();
    }

    /// Cold-start: spawn every persisted session and resume its loops without
    /// waiting for the user to attach.
    pub(crate) async fn bootstrap_sessions(&mut self) {
        let ids = eta_sqlite_storage::list_sessions_in(&eta_fs::sessions_dir()).unwrap_or_default();
        for id in ids {
            if self.sessions.get(&id).is_some() {
                continue;
            }
            if let Ok(plan) = controller::assemble_resume(&id).await {
                let tool_names = plan.tool_names.clone();
                let handle = controller::spawn(plan);
                if let Some(loop_manager) = handle.loop_manager.clone() {
                    loop_manager.start().await;
                }
                self.sessions.insert(handle);
                self.views.entry(id.clone()).or_default().tool_names = tool_names;
            }
        }
    }
}

/// Truncate a status-bar label to `max` chars, adding an ellipsis when needed.
fn shorten(text: &str, max: usize) -> String {
    let chars = text.chars().collect::<Vec<_>>();
    if chars.len() <= max {
        return text.to_string();
    }
    let keep = max.saturating_sub(1);
    chars[..keep].iter().collect::<String>() + "…"
}

/// Extract a short preview of the last user/assistant message in a session.
fn last_message_preview(entries: &[SessionEntry]) -> String {
    for entry in entries.iter().rev() {
        if entry.kind != entry_kind::USER_MESSAGE && entry.kind != entry_kind::ASSISTANT_MESSAGE {
            continue;
        }
        let text = entry
            .data
            .get("content")
            .map(|content| {
                content
                    .as_str()
                    .map(String::from)
                    .or_else(|| {
                        content
                            .get("text")
                            .and_then(|text| text.as_str())
                            .map(String::from)
                    })
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        if !text.is_empty() {
            return text.chars().take(40).collect();
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::last_message_preview;
    use crossterm::event::{Event, KeyCode, KeyEvent};
    use eta_core::{SessionEntry, entry_kind};
    use tui_textarea::TextArea;

    #[test]
    fn textarea_lines_after_typing_slash_g() {
        let mut area = TextArea::default();
        area.input(Event::Key(KeyEvent::from(KeyCode::Char('/'))));
        area.input(Event::Key(KeyEvent::from(KeyCode::Char('g'))));
        let joined = area.lines().join("\n");
        assert_eq!(joined, "/g");
    }

    #[test]
    fn app_completions_matches_slash_g() {
        let mut app = super::App::new();
        app.input.input(KeyEvent::from(KeyCode::Char('/')));
        app.input.input(KeyEvent::from(KeyCode::Char('g')));
        let comps = app.completions();
        assert!(
            comps.iter().any(|c| c.contains("/goal")),
            "expected goal completion, got {comps:?}"
        );
    }

    #[test]
    fn previews_last_message_and_truncates() {
        let entries = vec![
            SessionEntry {
                id: 0,
                kind: entry_kind::USER_MESSAGE.into(),
                data: serde_json::json!({"role": "user", "content": {"type": "text", "text": "first"}}),
            },
            SessionEntry {
                id: 1,
                kind: entry_kind::ASSISTANT_MESSAGE.into(),
                data: serde_json::json!({"role": "assistant", "content": {"type": "text", "text": "x".repeat(100)}}),
            },
        ];
        let preview = last_message_preview(&entries);
        assert_eq!(preview.chars().count(), 40);
        assert!(preview.starts_with('x'));
    }

    #[test]
    fn preview_ignores_non_message_entries() {
        let entries = vec![SessionEntry {
            id: 0,
            kind: entry_kind::USAGE.into(),
            data: serde_json::json!({"tokens": 3}),
        }];
        assert_eq!(last_message_preview(&entries), "");
    }
}
