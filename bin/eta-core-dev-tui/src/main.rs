//! `eta-core-dev-tui` — the dev-mode, full-screen coding agent.
//!
//! The app keeps one engine per session, drains each engine's event streams into
//! the answer/context/dev panels, and routes the input box to the current
//! session's `Agent`.

mod app;
mod commands;
mod config;
mod session;
mod tools;
mod tui;

use std::io;

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use tui::Focus;
use tui::screen::Screen;
use tui_textarea::TextArea;

use app::App;
use commands::{Command, parse_command};

/// Help text shown by `/help`.
const HELP_TEXT: &str = concat!(
    "commands:\n",
    "  /goal [set] <objective> | /goal pause|resume|cancel|reset\n",
    "  /loop <duration> <prompt> | /loop list | /loop cancel <id>\n",
    "  /fork <name> /commit <msg> /checkout <ref> /rollback <id> /history /merge <branch> /search <q>\n",
    "  /model [provider/model] /agent /compact /tools /skills /memory /todos /usage /help /quit\n"
);

#[tokio::main]
async fn main() -> io::Result<()> {
    let mut terminal = ratatui::init();
    let mut app = App::new();
    let result = run(&mut terminal, &mut app).await;
    ratatui::restore();
    result
}

/// Event loop: pump engine events when in a session, draw the active screen,
/// and route input depending on the screen.
async fn run(terminal: &mut ratatui::DefaultTerminal, app: &mut App) -> io::Result<()> {
    loop {
        if matches!(app.screen, Screen::Session) {
            app.pump().await;
        }
        terminal.draw(|frame| {
            tui::draw(
                frame,
                &app.screen,
                app.focus,
                &app.input,
                &app.answers,
                &app.dev,
                app.context.as_ref(),
                app.goal.as_ref(),
            )
        })?;

        match event::read()? {
            Event::Key(key) if key.kind == KeyEventKind::Press => {
                let ctrl_c =
                    key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL);
                if ctrl_c {
                    app.cancel_current();
                    continue;
                }
                let shift = key.modifiers.contains(KeyModifiers::SHIFT);
                match app.screen.clone() {
                    Screen::Startup { .. } => match key.code {
                        KeyCode::Up => app.screen.move_selection(-1),
                        KeyCode::Down => app.screen.move_selection(1),
                        KeyCode::Enter if !shift => {
                            let line = app.input.lines().join("\n");
                            app.input = TextArea::default();
                            if !line.trim().is_empty() {
                                if let Some(draft) = app.screen.text_mut() {
                                    *draft = line;
                                }
                                app.begin_agent_mode();
                            } else if let Some(id) =
                                app.screen.startup_selection().map(str::to_owned)
                            {
                                app.attach_existing_session(&id).await;
                            }
                        }
                        _ => {
                            let _ = app.input.input(key);
                        }
                    },
                    Screen::AgentMode { .. } => match key.code {
                        KeyCode::Up => app.screen.move_selection(-1),
                        KeyCode::Down => app.screen.move_selection(1),
                        KeyCode::Enter => app.confirm_agent_mode(),
                        KeyCode::Esc => app.cancel_picker(),
                        _ => {}
                    },
                    Screen::AgentPicker { .. } => match key.code {
                        KeyCode::Up => app.screen.move_selection(-1),
                        KeyCode::Down => app.screen.move_selection(1),
                        KeyCode::Enter => app.confirm_existing_agent().await,
                        KeyCode::Esc => app.cancel_picker(),
                        _ => {}
                    },
                    Screen::CreateAgentName { .. } => {
                        if key.code == KeyCode::Enter && !shift {
                            let line = app.input.lines().join("\n");
                            app.input = TextArea::default();
                            if let Some(name) = app.screen.text_mut() {
                                *name = line;
                            }
                            app.begin_persona_picker();
                        } else {
                            let _ = app.input.input(key);
                        }
                    }
                    Screen::PersonaPicker { .. } => match key.code {
                        KeyCode::Up => app.screen.move_selection(-1),
                        KeyCode::Down => app.screen.move_selection(1),
                        KeyCode::Enter => app.confirm_new_agent().await,
                        KeyCode::Esc => app.cancel_picker(),
                        _ => {}
                    },
                    Screen::ModelPicker { .. } => match key.code {
                        KeyCode::Up => app.screen.move_selection(-1),
                        KeyCode::Down => app.screen.move_selection(1),
                        KeyCode::Enter => app.confirm_model_picker().await,
                        KeyCode::Esc => app.cancel_picker(),
                        _ => {}
                    },
                    Screen::AgentSwitch { .. } => match key.code {
                        KeyCode::Up => app.screen.move_selection(-1),
                        KeyCode::Down => app.screen.move_selection(1),
                        KeyCode::Enter => app.confirm_agent_switch(),
                        KeyCode::Esc => app.cancel_picker(),
                        _ => {}
                    },
                    Screen::SessionPicker { .. } => match key.code {
                        KeyCode::Up => app.screen.move_selection(-1),
                        KeyCode::Down => app.screen.move_selection(1),
                        KeyCode::Enter => app.confirm_session_picker(),
                        KeyCode::Esc => app.cancel_picker(),
                        _ => {}
                    },
                    Screen::Session => {
                        if key.code == KeyCode::Tab {
                            app.focus = app.focus.next();
                            continue;
                        }
                        if app.focus == Focus::Input {
                            match key.code {
                                KeyCode::Enter if !shift => {
                                    let line = app.input.lines().join("\n");
                                    app.input = TextArea::default();
                                    if app.pending_ask.is_some() {
                                        app.answer_ask_user(line.trim().to_string()).await;
                                        continue;
                                    }
                                    if let Some(command) = parse_command(&line) {
                                        match &command {
                                            Command::Quit => return Ok(()),
                                            Command::Clear => app.answers.clear(),
                                            Command::Help => {
                                                app.answers.push(HELP_TEXT.to_string())
                                            }
                                            Command::LoopAdd { schedule, prompt } => {
                                                if let Some(id) = app
                                                    .register_loop(schedule.clone(), prompt.clone())
                                                    .await
                                                {
                                                    app.answers
                                                        .push(format!("registered loop {id}"));
                                                }
                                            }
                                            Command::LoopList => {
                                                if let Some(lines) = app.list_loops().await {
                                                    app.answers.extend(lines);
                                                }
                                            }
                                            Command::LoopRemove(id) => {
                                                if let Some(removed) = app.remove_loop(id).await {
                                                    app.answers
                                                        .push(format!("removed loop: {removed}"));
                                                }
                                            }
                                            Command::Model(Some(id)) => {
                                                app.save_model(id).await;
                                                app.answers.push(format!("model: {id} (session)"));
                                            }
                                            Command::Model(None) => {
                                                app.open_model_picker();
                                            }
                                            Command::Agent => {
                                                app.open_agent_switch();
                                            }
                                            Command::Session => {
                                                app.open_session_picker().await;
                                            }
                                            Command::NewSession | Command::SessionNew => {
                                                let recent = eta_sqlite_storage::list_sessions_in(
                                                    &eta_fs::sessions_dir(),
                                                )
                                                .unwrap_or_default();
                                                app.screen = Screen::startup(recent);
                                                app.input = TextArea::default();
                                            }
                                            Command::LoadOtherAgentConfig => {
                                                match eta_anycodingagent_config_reader::import_from_default_home()
                                                {
                                                    Ok(imported) => {
                                                        let entries = imported.model_entries();
                                                        if entries.is_empty() {
                                                            app.answers.push(
                                                                "no custom models found".into(),
                                                            );
                                                        } else {
                                                            app.answers.extend(entries);
                                                        }
                                                    }
                                                    Err(error) => app.answers.push(format!(
                                                        "config load error: {error}"
                                                    )),
                                                }
                                            }
                                            _ => {
                                                if let Some(line) = app.apply_time_travel(&command)
                                                {
                                                    app.answers.push(line);
                                                } else if let Some(input) = command.to_agent_input()
                                                {
                                                    app.send_input(input).await;
                                                }
                                            }
                                        }
                                    } else if !line.trim().is_empty() {
                                        app.send_message(line.trim()).await;
                                    }
                                }
                                KeyCode::Char('d')
                                    if key.modifiers.contains(KeyModifiers::CONTROL) =>
                                {
                                    return Ok(());
                                }
                                _ => {
                                    let _ = app.input.input(key);
                                }
                            }
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
    use crate::app::App;
    use crate::session::{SessionManager, spawn_session};
    use eta_core::{Agent, AgentEvent, AgentId, AgentInput, MemoryStore, SessionStorage};
    use eta_llm::{Context, Event, Model, Provider, ProviderError, StopReason, Usage};
    use eta_sqlite_storage::{SqliteAgentStore, SqliteSessionStore};
    use serde_json::json;
    use std::pin::Pin;
    use std::sync::Arc;
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

    #[tokio::test]
    async fn loop_commands_manage_registry() {
        let provider: Arc<dyn Provider> = Arc::new(ScriptedProvider { events: vec![] });
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

        let id = app
            .register_loop("10m".into(), "ship it".into())
            .await
            .expect("loop id");
        assert!(id.starts_with("loop-"));

        let listed = app.list_loops().await.expect("loop list");
        assert!(listed.iter().any(|line| line.contains("ship it")));

        assert_eq!(app.remove_loop(&id).await, Some(true));
        assert!(app.list_loops().await.expect("loop list").is_empty());
    }

    #[tokio::test]
    async fn two_sessions_run_concurrently() {
        fn make(id: &str, text: &'static str) -> (AgentId, Agent) {
            let provider: Arc<dyn Provider> = Arc::new(ScriptedProvider {
                events: vec![
                    Ok(Event::Content(json!({"type": "text", "text": text}))),
                    Ok(Event::End {
                        usage: Usage::default(),
                        stop: StopReason::EndTurn,
                    }),
                ],
            });
            let handle = spawn_session(
                id,
                AgentId(id.into()),
                provider,
                Model::new("test-model"),
                Arc::new(SqliteSessionStore::in_memory()),
                Arc::new(SqliteAgentStore::in_memory()),
                vec![],
                "you are eta".into(),
                String::new(),
            );
            (AgentId(id.into()), handle.agent.expect("agent"))
        }

        let (id_a, agent_a) = make("a", "hello A");
        let (id_b, agent_b) = make("b", "hello B");
        let mut rx_a = agent_a.subscribe();
        let mut rx_b = agent_b.subscribe();

        agent_a
            .send(AgentInput::UserMessage {
                content: json!({"type": "text", "text": "go"}),
            })
            .await
            .unwrap();
        agent_b
            .send(AgentInput::UserMessage {
                content: json!({"type": "text", "text": "go"}),
            })
            .await
            .unwrap();

        let mut saw_a = false;
        let mut saw_b = false;
        for _ in 0..20 {
            if let Ok(event) = rx_a.try_recv() {
                if matches!(&event, AgentEvent::MessageUpdate { agent_id, message, .. }
                    if agent_id == &id_a && message.get("text").and_then(|v| v.as_str()) == Some("hello A"))
                {
                    saw_a = true;
                }
            }
            if let Ok(event) = rx_b.try_recv() {
                if matches!(&event, AgentEvent::MessageUpdate { agent_id, message, .. }
                    if agent_id == &id_b && message.get("text").and_then(|v| v.as_str()) == Some("hello B"))
                {
                    saw_b = true;
                }
            }
            if saw_a && saw_b {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(saw_a, "session A did not stream");
        assert!(saw_b, "session B did not stream");
    }
}
