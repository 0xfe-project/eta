//! Application state and session/agent/model lifecycle for the dev TUI.

use std::sync::Arc;
use std::time::Instant;

use eta_core::{
    AgentEvent, AgentId, AgentInput, AskUserAnswer, LoopSpec, MemoryStore, SessionStorage, Trigger,
    dev_category,
};
use eta_io_tools::builtin_io_tools;
use eta_llm::{Model, Provider};
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
    pub(crate) answers: Vec<String>,
    pub(crate) dev: Vec<String>,
    pub(crate) context: Option<ContextSnapshot>,
    pub(crate) goal: Option<GoalInfo>,
    pub(crate) pending_ask: Option<PendingAsk>,
    pub(crate) dev_base: Instant,
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
            answers: Vec::new(),
            dev: Vec::new(),
            context: None,
            goal: None,
            pending_ask: None,
            dev_base: Instant::now(),
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
        let Some(handle) = self.sessions.current_mut() else {
            return;
        };
        let agent_id = handle.meta.agent_id.clone();

        if let Some(events) = handle.event_rx.as_mut() {
            while let Ok(event) = events.try_recv() {
                if let AgentEvent::AskUserStarted { req_id, .. } = &event {
                    self.pending_ask = Some(PendingAsk {
                        req_id: req_id.clone(),
                    });
                }
                if let Some(line) = tui::answer::event_line(&agent_id, &event) {
                    self.answers.push(line);
                }
            }
        }

        if let Some(dev_events) = handle.dev_rx.as_mut() {
            while let Ok(event) = dev_events.try_recv() {
                self.dev
                    .push(tui::dev::dev_event_line(&event, self.dev_base));
                if event.category == dev_category::GOAL && event.action == "change" {
                    self.goal = Some(GoalInfo {
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

        let usage = handle
            .agent
            .as_ref()
            .map(|agent| agent.usage())
            .unwrap_or_default();
        self.context = Some(ContextSnapshot {
            session_id: handle.meta.id.clone(),
            branch: "main".to_string(),
            input_tokens: usage.input,
            output_tokens: usage.output,
            cache_read: usage.cache_read,
            cache_write: usage.cache_write,
            cache_rate: usage.cache_rate(),
            ..Default::default()
        });
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
        let mut config = eta_config::Config {
            model: String::new(),
            small_model: None,
            provider: Default::default(),
            persona: vec![],
        };
        if let Ok(imported) = eta_anycodingagent_config_reader::import_from_default_home() {
            imported.apply_to(&mut config);
        }
        config::model_entries(&config)
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
        self.answers.push(format!("model: {model} (session)"));
    }

    pub(crate) fn respawn_with_model(&mut self, model_id: &str) {
        let Some(session) = self.sessions.current() else {
            return;
        };
        let session_id = session.meta.id.clone();
        let agent_id = session.meta.agent_id.clone();
        let store = session.store.clone();
        let provider: Arc<dyn Provider> = Arc::new(OpenAiProvider::from_env());
        let id = model_id
            .split('/')
            .next_back()
            .unwrap_or(model_id)
            .to_string();
        let model = Model::new(id);
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

    pub(crate) fn switch_agent(&mut self, name: &str) {
        let Some(session) = self.sessions.current() else {
            return;
        };
        let session_id = session.meta.id.clone();
        let store = session.store.clone();
        let provider: Arc<dyn Provider> = Arc::new(OpenAiProvider::from_env());
        let model = Model::new(std::env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-4o".into()));
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
        self.answers.push(format!("agent: {name}"));
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
    #[allow(dead_code)] // wired into the startup recent-session cursor in E5.
    pub(crate) fn attach_existing_session(&mut self, session_id: &str) {
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
        self.sqlite = Some(sqlite);
        self.sessions.insert(handle);
        self.sessions.attach(session_id);
        self.screen = Screen::session();
    }
}
