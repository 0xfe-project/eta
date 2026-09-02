//! `eta-core-dev-tui` — the dev-mode, full-screen coding agent.
//!
//! The app keeps one engine per session, drains each engine's event streams into
//! the answer/context/dev panels, and routes the input box to the current
//! session's `Agent`.

mod commands;
mod config;
mod session;
mod tools;
mod tui;

use std::io;
use std::sync::Arc;
use std::time::Instant;

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use eta_core::{AgentId, AgentInput, MemoryStore, SessionStorage};
use eta_io_tools::builtin_io_tools;
use eta_llm::{Model, Provider};
use eta_provider_openai::OpenAiProvider;
use eta_sqlite_storage::{SqliteAgentStore, SqliteSessionStore};
use eta_system_prompts::DEFAULT_SYSTEM_PROMPT;
use serde_json::json;
use session::{SessionManager, spawn_session};
use tui::{ContextSnapshot, Focus};
use tui_textarea::TextArea;

use commands::{Command, parse_command};

/// Interactive UI state: current focus, input, the session registry, and the
/// rendered buffers for the three upper panels.
struct App {
    focus: Focus,
    input: TextArea<'static>,
    sessions: SessionManager,
    sqlite: Option<Arc<SqliteSessionStore>>,
    head: Option<u64>,
    answers: Vec<String>,
    dev: Vec<String>,
    context: Option<ContextSnapshot>,
    dev_base: Instant,
}

impl App {
    fn new() -> Self {
        let mut input = TextArea::default();
        input.set_placeholder_text("type a message…");
        Self {
            focus: Focus::Input,
            input,
            sessions: SessionManager::new(),
            sqlite: None,
            head: None,
            answers: Vec::new(),
            dev: Vec::new(),
            context: None,
            dev_base: Instant::now(),
        }
    }

    fn with_sessions(sessions: SessionManager) -> Self {
        let mut app = Self::new();
        app.sessions = sessions;
        app
    }

    fn with_runtime(sessions: SessionManager, sqlite: Arc<SqliteSessionStore>) -> Self {
        let mut app = Self::with_sessions(sessions);
        app.sqlite = Some(sqlite);
        app
    }

    /// Drain the current session's engine/dev streams into the panels and
    /// refresh the context snapshot from `Agent::usage()`.
    async fn pump(&mut self) {
        let Some(handle) = self.sessions.current_mut() else {
            return;
        };
        let agent_id = handle.meta.agent_id.clone();

        if let Some(events) = handle.event_rx.as_mut() {
            while let Ok(event) = events.try_recv() {
                if let Some(line) = tui::answer::event_line(&agent_id, &event) {
                    self.answers.push(line);
                }
            }
        }

        if let Some(dev_events) = handle.dev_rx.as_mut() {
            while let Ok(event) = dev_events.try_recv() {
                self.dev
                    .push(tui::dev::dev_event_line(&event, self.dev_base));
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
    async fn send_message(&mut self, text: &str) {
        self.send_input(AgentInput::UserMessage {
            content: json!({ "type": "text", "text": text }),
        })
        .await;
    }

    /// Send an engine input to the currently attached session.
    async fn send_input(&mut self, input: AgentInput) {
        let Some(handle) = self.sessions.current() else {
            return;
        };
        if let Some(agent) = handle.agent.as_ref() {
            let _ = agent.send(input).await;
        }
    }

    /// Apply a time-travel command against the concrete SQLite session store.
    fn apply_time_travel(&mut self, command: &Command) -> Option<String> {
        let sqlite = self.sqlite.as_ref()?;
        session::apply_time_travel(sqlite, &mut self.head, command)
    }
}

/// Build a single default session from environment-configured OpenAI-compatible
/// provider + io tools + in-memory SQLite stores. The durable paths are swapped
/// in E5/E6 when session/agent lifecycle is wired.
fn spawn_default_session() -> (SessionManager, Arc<SqliteSessionStore>) {
    let mut manager = SessionManager::new();
    let provider: Arc<dyn Provider> = Arc::new(OpenAiProvider::from_env());
    let model = Model::new(std::env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-4o".into()));
    let sqlite = Arc::new(SqliteSessionStore::in_memory());
    let store: Arc<dyn SessionStorage> = sqlite.clone();
    let memory: Arc<dyn MemoryStore> = Arc::new(SqliteAgentStore::in_memory());
    let handle = spawn_session(
        "default",
        AgentId("eta".into()),
        provider,
        model,
        store,
        memory,
        builtin_io_tools(),
        DEFAULT_SYSTEM_PROMPT.to_string(),
        String::new(),
    );
    manager.insert(handle);
    manager.attach("default");
    (manager, sqlite)
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let mut terminal = ratatui::init();
    let (sessions, sqlite) = spawn_default_session();
    let mut app = App::with_runtime(sessions, sqlite);
    let result = run(&mut terminal, &mut app).await;
    ratatui::restore();
    result
}

/// Event loop: pump engine events, draw the four panels, route input.
async fn run(terminal: &mut ratatui::DefaultTerminal, app: &mut App) -> io::Result<()> {
    loop {
        app.pump().await;
        terminal.draw(|frame| {
            tui::draw(
                frame,
                app.focus,
                &app.input,
                &app.answers,
                &app.dev,
                app.context.as_ref(),
            )
        })?;

        match event::read()? {
            Event::Key(key) if key.kind == KeyEventKind::Press => {
                let ctrl_c =
                    key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL);
                if ctrl_c {
                    return Ok(());
                }
                if key.code == KeyCode::Tab {
                    app.focus = app.focus.next();
                    continue;
                }
                if app.focus == Focus::Input {
                    let shift = key.modifiers.contains(KeyModifiers::SHIFT);
                    match key.code {
                        KeyCode::Enter if !shift => {
                            let line = app.input.lines().join("\n");
                            app.input = TextArea::default();
                            if let Some(command) = parse_command(&line) {
                                match &command {
                                    Command::Quit => return Ok(()),
                                    Command::Clear => app.answers.clear(),
                                    _ => {
                                        if let Some(line) = app.apply_time_travel(&command) {
                                            app.answers.push(line);
                                        } else if let Some(input) = command.to_agent_input() {
                                            app.send_input(input).await;
                                        }
                                    }
                                }
                            } else if !line.trim().is_empty() {
                                app.send_message(line.trim()).await;
                            }
                        }
                        KeyCode::Char('d') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                            return Ok(());
                        }
                        _ => {
                            let _ = app.input.input(key);
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AgentId, App, Arc, MemoryStore, SessionManager, SessionStorage, spawn_session};
    use eta_llm::{Context, Event, Model, Provider, ProviderError, StopReason, Usage};
    use eta_sqlite_storage::{SqliteAgentStore, SqliteSessionStore};
    use serde_json::json;
    use std::pin::Pin;
    use std::time::Duration;
    use tokio_stream::Stream;

    struct ScriptedProvider {
        events: Vec<Result<Event, ProviderError>>,
    }

    impl Provider for ScriptedProvider {
        fn stream(
            &self,
            _model: &Model,
            _context: &Context,
            _opts: Option<&serde_json::Value>,
        ) -> Pin<Box<dyn Stream<Item = Result<Event, ProviderError>> + Send>> {
            Box::pin(tokio_stream::iter(self.events.clone()))
        }
    }

    #[tokio::test]
    async fn app_pumps_engine_events_into_answer_panel() {
        let provider: Arc<dyn Provider> = Arc::new(ScriptedProvider {
            events: vec![
                Ok(Event::Content(json!({"type": "text", "text": "hello"}))),
                Ok(Event::End {
                    usage: Usage::default(),
                    stop: StopReason::EndTurn,
                }),
            ],
        });
        let store: Arc<dyn SessionStorage> = Arc::new(SqliteSessionStore::in_memory());
        let memory: Arc<dyn MemoryStore> = Arc::new(SqliteAgentStore::in_memory());
        let handle = spawn_session(
            "s1",
            AgentId("dev".into()),
            provider,
            Model::new("test-model"),
            store,
            memory,
            vec![],
            "you are eta".into(),
            String::new(),
        );

        let mut sessions = SessionManager::new();
        sessions.insert(handle);
        sessions.attach("s1");
        let mut app = App::with_sessions(sessions);

        app.send_message("hi").await;
        for _ in 0..20 {
            app.pump().await;
            if app.answers.iter().any(|line| line.contains("hello")) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        assert!(
            app.answers.iter().any(|line| line.contains("hello")),
            "answer panel was not updated: {:?}",
            app.answers
        );
        assert!(app.context.is_some(), "context snapshot was not refreshed");
    }
}
