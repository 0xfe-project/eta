//! Application state and session/agent/model lifecycle for the dev TUI.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use crossterm::event::KeyCode;

use eta_core::{
    AgentEvent, AgentId, AgentInput, AskUserAnswer, LoopSpec, MemoryStore, SessionEntry,
    SessionStorage, Trigger, dev_category, entry_kind,
};
use eta_io_tools::builtin_io_tools;
use eta_llm::{Model, Provider};
use eta_provider_anthropic::AnthropicProvider;
use eta_provider_openai::OpenAiProvider;
use eta_sqlite_storage::{SqliteAgentStore, SqliteSessionStore};
use eta_system_prompts::DEFAULT_SYSTEM_PROMPT;
use serde_json::json;

use crate::commands::Command;
use crate::config;
use crate::session::{self, SessionManager, spawn_session};
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
    pub(crate) pending_ask: Option<PendingAsk>,
    pub(crate) dev_base: Instant,
    history: Vec<String>,
    history_idx: Option<usize>,
    pub(crate) dev_filter: String,
    pub(crate) dev_filtering: bool,
    pub(crate) current_model: String,
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
            pending_ask: None,
            dev_base: Instant::now(),
            history: Vec::new(),
            history_idx: None,
            dev_filter: String::new(),
            dev_filtering: false,
            current_model: std::env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-4o".into()),
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
        *scroll = (*scroll as i64 + delta).clamp(0, len as i64) as usize;
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
        let session = self.sessions.current_id().unwrap_or("-");
        let agent = self
            .sessions
            .current()
            .map(|handle| handle.meta.agent_id.0.clone())
            .unwrap_or_default();
        format!(
            "{mode} · session {session} · agent {agent} · model {}",
            self.current_model
        )
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
        let mut answer_lines = Vec::new();
        let mut dev_lines = Vec::new();
        let mut new_goal: Option<GoalInfo> = None;
        let usage;
        let session_id;
        {
            let Some(handle) = self.sessions.current_mut() else {
                return;
            };
            let agent_id = handle.meta.agent_id.clone();
            session_id = handle.meta.id.clone();

            if let Some(events) = handle.event_rx.as_mut() {
                let mut saw_text = false;
                while let Ok(event) = events.try_recv() {
                    if let AgentEvent::MessageUpdate { message, .. } = &event {
                        if message
                            .get("text")
                            .and_then(|text| text.as_str())
                            .is_some_and(|text| !text.is_empty())
                        {
                            saw_text = true;
                        }
                    }
                    if let AgentEvent::TurnStart { .. } = &event {
                        saw_text = false;
                    }
                    if let AgentEvent::TurnEnd { .. } = &event {
                        if !saw_text {
                            answer_lines.push(
                                "(no assistant text this turn — check model/provider or dev events)"
                                    .to_string(),
                            );
                        }
                    }
                    if let AgentEvent::AskUserStarted { req_id, .. } = &event {
                        self.pending_ask = Some(PendingAsk {
                            req_id: req_id.clone(),
                        });
                    }
                    if let Some(line) = tui::answer::event_line(&agent_id, &event) {
                        answer_lines.push(line);
                    }
                }
            }

            if let Some(dev_events) = handle.dev_rx.as_mut() {
                while let Ok(event) = dev_events.try_recv() {
                    dev_lines.push(tui::dev::dev_event_line(&event, self.dev_base));
                    if event.category == dev_category::GOAL && event.action == "change" {
                        new_goal = Some(GoalInfo {
                            status: event
                                .data
                                .get("status")
                                .and_then(|value| value.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            objective: event
                                .data
                                .get("objective")
                                .and_then(|value| value.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            round: event
                                .data
                                .get("round_count")
                                .and_then(|value| value.as_u64())
                                .unwrap_or_default(),
                        });
                    }
                }
            }

            usage = handle
                .agent
                .as_ref()
                .map(|agent| agent.usage())
                .unwrap_or_default();
        }

        let view = self.views.entry(session_id.clone()).or_default();
        view.answers.extend(answer_lines);
        view.dev.extend(dev_lines);
        let goal_text = new_goal
            .as_ref()
            .or(view.goal.as_ref())
            .map(|goal| goal.status_line())
            .unwrap_or_default();
        view.context = Some(ContextSnapshot {
            session_id,
            branch: "main".to_string(),
            input_tokens: usage.input,
            output_tokens: usage.output,
            cache_read: usage.cache_read,
            cache_write: usage.cache_write,
            cache_rate: usage.cache_rate(),
            goal: goal_text,
            ..Default::default()
        });
        if let Some(goal) = new_goal {
            view.goal = Some(goal);
        }
    }

    /// Send a plain user message to the currently attached session.
    pub(crate) async fn send_message(&mut self, text: &str) {
        self.send_input(AgentInput::UserMessage {
            content: json!({ "type": "text", "text": text }),
        })
        .await;
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
        session::apply_time_travel(sqlite, &mut self.head, command)
    }

    /// Register a cron loop on the current session and return its id.
    pub(crate) async fn register_loop(
        &mut self,
        schedule: String,
        prompt: String,
    ) -> Option<String> {
        self.loop_counter += 1;
        let loop_id = format!("loop-{}", self.loop_counter);
        let spec = LoopSpec {
            loop_id: loop_id.clone(),
            prompt: prompt.clone(),
            trigger: Trigger::Cron { schedule },
            enabled: true,
            last_fired_at: None,
            run_count: 0,
            state: json!({}),
        };
        let manager = self.sessions.current()?.loop_manager.as_ref()?;
        manager.register(spec).await;
        Some(loop_id)
    }

    pub(crate) async fn list_loops(&mut self) -> Option<Vec<String>> {
        let manager = self.sessions.current()?.loop_manager.as_ref()?;
        let specs = manager.list().await;
        Some(
            specs
                .into_iter()
                .map(|spec| format!("{} - {}", spec.loop_id, spec.prompt))
                .collect(),
        )
    }

    pub(crate) async fn remove_loop(&mut self, loop_id: &str) -> Option<bool> {
        let manager = self.sessions.current()?.loop_manager.as_ref()?;
        Some(manager.remove(loop_id).await)
    }

    /// Persist a per-session model override in session KV.
    pub(crate) async fn save_model(&mut self, model: &str) {
        if let Some(handle) = self.sessions.current() {
            let store = handle.store.clone();
            session::save_model(store.as_ref(), model).await;
        }
    }

    pub(crate) fn model_catalog(&self) -> Vec<String> {
        config::model_entries(&self.load_config())
    }

    /// Load the user's custom provider/model catalog from home.
    fn load_config(&self) -> eta_config::Config {
        let mut config = eta_config::Config {
            model: String::new(),
            small_model: None,
            provider: Default::default(),
            persona: vec![],
        };
        if let Ok(imported) = eta_anycodingagent_config_reader::import_from_default_home() {
            imported.apply_to(&mut config);
        }
        config
    }

    /// Resolve a `provider/model` entry into a provider + model carrying the
    /// provider's base URL and wire protocol.
    fn resolve_provider_model(&self, entry: &str) -> (Arc<dyn Provider>, Model) {
        let (provider_id, model_id) = entry.split_once('/').unwrap_or((entry, entry));
        let config = self.load_config();
        let Some(provider) = config.provider.get(provider_id) else {
            return (Arc::new(OpenAiProvider::from_env()), Model::new(model_id));
        };
        let base = provider
            .options
            .get("baseURL")
            .or_else(|| provider.options.get("base_url"))
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let key = provider
            .options
            .get("apiKey")
            .or_else(|| provider.options.get("api_key"))
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let mut model = Model::new(model_id);
        model.api = Some(provider.format.as_str().to_string());
        model.base_url = Some(base.to_string());
        let provider: Arc<dyn Provider> =
            if provider.format == eta_config::ProviderFormat::AnthropicMessages {
                Arc::new(AnthropicProvider::new(Some(key.to_string()), base))
            } else {
                Arc::new(OpenAiProvider::new(Some(key.to_string()), base))
            };
        (provider, model)
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
        self.respawn_with_model(&model);
        self.screen = Screen::session();
        self.view()
            .answers
            .push(format!("model: {model} (session)"));
    }

    pub(crate) fn respawn_with_model(&mut self, model_id: &str) {
        let Some(session) = self.sessions.current() else {
            return;
        };
        let session_id = session.meta.id.clone();
        let agent_id = session.meta.agent_id.clone();
        let store = session.store.clone();
        let (provider, model) = self.resolve_provider_model(model_id);
        self.current_model = model.id.clone();
        let memory: Arc<dyn MemoryStore> = Arc::new(
            SqliteAgentStore::open(eta_fs::agent_db(&agent_id.to_string()))
                .unwrap_or_else(|_| SqliteAgentStore::in_memory()),
        );
        let handle = spawn_session(
            &session_id,
            agent_id,
            provider,
            model,
            store,
            memory,
            builtin_io_tools(),
            DEFAULT_SYSTEM_PROMPT.to_string(),
            String::new(),
        );
        self.sessions = SessionManager::new();
        self.sessions.insert(handle);
        self.sessions.attach(&session_id);
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

    pub(crate) fn switch_agent(&mut self, name: &str) {
        let Some(session) = self.sessions.current() else {
            return;
        };
        let session_id = session.meta.id.clone();
        let store = session.store.clone();
        let provider: Arc<dyn Provider> = Arc::new(OpenAiProvider::from_env());
        let model = Model::new(std::env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-4o".into()));
        self.current_model = model.id.clone();
        let memory: Arc<dyn MemoryStore> = Arc::new(
            SqliteAgentStore::open(eta_fs::agent_db(name))
                .unwrap_or_else(|_| SqliteAgentStore::in_memory()),
        );
        let handle = spawn_session(
            &session_id,
            AgentId(name.to_string()),
            provider,
            model,
            store,
            memory,
            builtin_io_tools(),
            DEFAULT_SYSTEM_PROMPT.to_string(),
            String::new(),
        );
        self.sessions = SessionManager::new();
        self.sessions.insert(handle);
        self.sessions.attach(&session_id);
        self.view().answers.push(format!("agent: {name}"));
    }

    pub(crate) fn confirm_agent_switch(&mut self) {
        let Some(name) = self.screen.confirm_agent_switch() else {
            return;
        };
        self.switch_agent(&name);
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
        self.spawn_session_for_agent(&agent, None);
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
        self.spawn_session_for_agent(&name, Some(&persona));
        self.screen = Screen::session();
        self.send_message(&draft).await;
    }

    pub(crate) fn spawn_session_for_agent(&mut self, name: &str, persona: Option<&str>) {
        let provider: Arc<dyn Provider> = Arc::new(OpenAiProvider::from_env());
        let model = Model::new(std::env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-4o".into()));
        self.current_model = model.id.clone();
        let session_id = uuid::Uuid::now_v7().to_string();
        let _ = std::fs::create_dir_all(eta_fs::sessions_dir());
        let _ = std::fs::create_dir_all(eta_fs::agents_dir());
        let sqlite = Arc::new(
            SqliteSessionStore::open(eta_fs::session_db(&session_id))
                .unwrap_or_else(|_| SqliteSessionStore::in_memory()),
        );
        let store: Arc<dyn SessionStorage> = sqlite.clone();
        let memory: Arc<dyn MemoryStore> = Arc::new(
            SqliteAgentStore::open(eta_fs::agent_db(name))
                .unwrap_or_else(|_| SqliteAgentStore::in_memory()),
        );
        let body = persona
            .and_then(|persona| eta_system_prompts::builtin_personas().get(persona).cloned())
            .unwrap_or_default();
        let system_prompt = format!("{DEFAULT_SYSTEM_PROMPT}\n\n{body}");
        let handle = spawn_session(
            &session_id,
            AgentId(name.to_string()),
            provider,
            model,
            store,
            memory,
            builtin_io_tools(),
            system_prompt,
            String::new(),
        );
        self.sqlite = Some(sqlite);
        self.sessions = SessionManager::new();
        self.sessions.insert(handle);
        self.sessions.attach(&session_id);
    }

    /// Open an existing session by id and spawn its agent, then attach it.
    pub(crate) async fn attach_existing_session(&mut self, session_id: &str) {
        let Some((handle, sqlite)) = self.spawn_session_handle(session_id) else {
            return;
        };
        if let Some(loop_manager) = handle.loop_manager.clone() {
            loop_manager.start().await;
        }
        self.sqlite = Some(sqlite);
        self.sessions.insert(handle);
        self.sessions.attach(session_id);
        self.screen = Screen::session();
    }

    /// Open an existing session store and spawn its agent without attaching.
    fn spawn_session_handle(
        &self,
        session_id: &str,
    ) -> Option<(crate::session::SessionHandle, Arc<SqliteSessionStore>)> {
        let sqlite = Arc::new(
            SqliteSessionStore::open(eta_fs::session_db(session_id))
                .unwrap_or_else(|_| SqliteSessionStore::in_memory()),
        );
        let store: Arc<dyn SessionStorage> = sqlite.clone();
        let provider: Arc<dyn Provider> = Arc::new(OpenAiProvider::from_env());
        let model = Model::new(std::env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-4o".into()));
        let memory: Arc<dyn MemoryStore> = Arc::new(
            SqliteAgentStore::open(eta_fs::agent_db(session_id))
                .unwrap_or_else(|_| SqliteAgentStore::in_memory()),
        );
        let handle = spawn_session(
            session_id,
            AgentId(session_id.to_string()),
            provider,
            model,
            store,
            memory,
            builtin_io_tools(),
            DEFAULT_SYSTEM_PROMPT.to_string(),
            String::new(),
        );
        Some((handle, sqlite))
    }

    /// Cold-start: spawn every persisted session and resume its loops without
    /// waiting for the user to attach.
    pub(crate) async fn bootstrap_sessions(&mut self) {
        let ids = eta_sqlite_storage::list_sessions_in(&eta_fs::sessions_dir()).unwrap_or_default();
        for id in ids {
            if self.sessions.get(&id).is_some() {
                continue;
            }
            if let Some((handle, _sqlite)) = self.spawn_session_handle(&id) {
                if let Some(loop_manager) = handle.loop_manager.clone() {
                    loop_manager.start().await;
                }
                self.sessions.insert(handle);
            }
        }
    }
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
