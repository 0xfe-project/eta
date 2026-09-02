//! Multi-session registry and attach model (E6).
//!
//! The manager owns the sessions but never drives the engine itself: each
//! session keeps its own `Agent` (spawned separately), so background sessions
//! keep running while another session is attached.
//!
//! `SessionManager` is exercised by unit tests now and fully wired in E5/E6.
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use eta_core::{
    Agent, AgentConfig, AgentDevEvent, AgentEvent, AgentId, Hooks, MemoryStore, SessionStorage,
    Tool,
};
use eta_llm::{Model, Provider};
use eta_sqlite_storage::{SqliteSessionStore, list_sessions_in};

/// Coarse lifecycle label shown in the `/session` picker.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SessionStatus {
    Running,
    Idle,
    #[default]
    Empty,
}

/// Lightweight, display-oriented session metadata.
#[derive(Clone, Debug)]
pub struct SessionMeta {
    pub id: String,
    pub agent_id: AgentId,
    pub status: SessionStatus,
    pub goal: Option<String>,
    pub turn_count: u64,
    pub last_activity: Instant,
}

/// A single session: its engine handle (if spawned), store, and metadata.
pub struct SessionHandle {
    pub agent: Option<Agent>,
    pub event_rx: Option<tokio::sync::broadcast::Receiver<AgentEvent>>,
    pub dev_rx: Option<tokio::sync::broadcast::Receiver<AgentDevEvent>>,
    pub store: Arc<dyn SessionStorage>,
    pub meta: SessionMeta,
}

/// The attach-model registry. `current` is a pointer into `sessions`; switching
/// it re-points every panel without restarting any running core.
#[derive(Default)]
pub struct SessionManager {
    sessions: HashMap<String, SessionHandle>,
    current: Option<String>,
}

/// A small cursor-over-list helper for the session picker and persona/agent
/// selection popups. Pure and reusable; `↑`/`↓` move the cursor, `Enter`
/// returns the selected item.
#[derive(Clone, Debug)]
pub struct Picker<T> {
    items: Vec<T>,
    selected: usize,
}

impl<T> Picker<T> {
    pub fn new(items: Vec<T>) -> Self {
        Self { items, selected: 0 }
    }

    pub fn move_up(&mut self) {
        self.selected = self.selected.saturating_sub(1);
    }

    pub fn move_down(&mut self) {
        if !self.items.is_empty() && self.selected + 1 < self.items.len() {
            self.selected += 1;
        }
    }

    pub fn selected(&self) -> Option<&T> {
        self.items.get(self.selected)
    }

    pub fn selected_index(&self) -> usize {
        self.selected
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register (or replace) a session handle.
    pub fn insert(&mut self, handle: SessionHandle) {
        let id = handle.meta.id.clone();
        self.sessions.insert(id, handle);
    }

    /// Attach the given session id, returning whether it exists.
    pub fn attach(&mut self, id: &str) -> bool {
        if self.sessions.contains_key(id) {
            self.current = Some(id.to_string());
            true
        } else {
            false
        }
    }

    pub fn current_id(&self) -> Option<&str> {
        self.current.as_deref()
    }

    pub fn current(&self) -> Option<&SessionHandle> {
        self.current.as_ref().and_then(|id| self.sessions.get(id))
    }

    pub fn current_mut(&mut self) -> Option<&mut SessionHandle> {
        self.current
            .clone()
            .and_then(|id| self.sessions.get_mut(&id))
    }

    pub fn get(&self, id: &str) -> Option<&SessionHandle> {
        self.sessions.get(id)
    }

    /// Remove and stop a session. Callers are responsible for aborting its
    /// agent before dropping the handle.
    pub fn remove(&mut self, id: &str) -> Option<SessionHandle> {
        if self.current.as_deref() == Some(id) {
            self.current = None;
        }
        self.sessions.remove(id)
    }

    pub fn ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.sessions.keys().cloned().collect();
        ids.sort();
        ids
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    /// Enumerate existing session files from a directory and register an
    /// unspawned handle for each. Missing files are ignored.
    pub fn from_dir(dir: impl AsRef<Path>) -> Self {
        let mut manager = Self::new();
        let Ok(ids) = list_sessions_in(dir.as_ref()) else {
            return manager;
        };
        for id in ids {
            if let Ok(store) = SqliteSessionStore::open(dir.as_ref().join(format!("{id}.sqlite"))) {
                manager.insert(SessionHandle {
                    agent: None,
                    event_rx: None,
                    dev_rx: None,
                    store: Arc::new(store),
                    meta: SessionMeta {
                        id: id.clone(),
                        agent_id: AgentId(id.clone()),
                        status: SessionStatus::Empty,
                        goal: None,
                        turn_count: 0,
                        last_activity: Instant::now(),
                    },
                });
            }
        }
        manager
    }
}

/// Build and spawn one independent engine (1 agent : 1 session). The concrete
/// adapters (provider, session store, memory store, tools) are injected so this
/// stays testable with a mock provider and in-memory stores.
#[allow(dead_code)]
pub fn spawn_session(
    session_id: impl Into<String>,
    agent_id: AgentId,
    provider: Arc<dyn Provider>,
    model: Model,
    store: Arc<dyn SessionStorage>,
    memory_store: Arc<dyn MemoryStore>,
    tools: Vec<Arc<dyn Tool>>,
    system_prompt: String,
    adapter_system_prompt: String,
) -> SessionHandle {
    let meta_agent_id = agent_id.clone();
    let agent = Agent::spawn(AgentConfig {
        agent_id,
        provider,
        model,
        tools,
        hooks: Hooks::new(),
        store: store.clone(),
        skill_store: None,
        memory_store,
        system_prompt,
        adapter_system_prompt,
        max_retries: 2,
        max_goal_rounds: None,
    });
    let event_rx = agent.subscribe();
    let dev_rx = agent.subscribe_dev();
    SessionHandle {
        agent: Some(agent),
        event_rx: Some(event_rx),
        dev_rx: Some(dev_rx),
        store,
        meta: SessionMeta {
            id: session_id.into(),
            agent_id: meta_agent_id,
            status: SessionStatus::Running,
            goal: None,
            turn_count: 0,
            last_activity: Instant::now(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{Picker, SessionHandle, SessionManager, SessionMeta, SessionStatus, spawn_session};
    use eta_core::{AgentEvent, AgentId, AgentInput, MemoryStore, SessionStorage};
    use eta_llm::{Context, Event, Model, Provider, ProviderError, StopReason, Usage};
    use eta_sqlite_storage::SqliteAgentStore;
    use eta_sqlite_storage::SqliteSessionStore;
    use serde_json::json;
    use std::pin::Pin;
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tokio_stream::Stream;

    /// Provider that replays one fixed stream on every call. Good enough for a
    /// single-turn smoke test: the engine reuses the same content for the
    /// out-of-band memory-extraction pass, which then finds no JSON edits.
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

    fn handle(id: &str) -> SessionHandle {
        SessionHandle {
            agent: None,
            event_rx: None,
            dev_rx: None,
            store: Arc::new(SqliteSessionStore::in_memory()),
            meta: SessionMeta {
                id: id.to_string(),
                agent_id: AgentId(id.to_string()),
                status: SessionStatus::Empty,
                goal: None,
                turn_count: 0,
                last_activity: Instant::now(),
            },
        }
    }

    #[test]
    fn attach_switches_current_without_removing_sessions() {
        let mut manager = SessionManager::new();
        manager.insert(handle("a"));
        manager.insert(handle("b"));
        assert!(manager.attach("a"));
        assert_eq!(manager.current_id(), Some("a"));
        assert!(manager.attach("b"));
        assert_eq!(manager.current_id(), Some("b"));
        assert_eq!(manager.ids(), vec!["a".to_string(), "b".to_string()]);
        assert!(!manager.attach("missing"));
    }

    #[test]
    fn remove_clears_current_when_targeted() {
        let mut manager = SessionManager::new();
        manager.insert(handle("a"));
        manager.insert(handle("b"));
        manager.attach("a");
        assert!(manager.remove("a").is_some());
        assert_eq!(manager.current_id(), None);
        assert_eq!(manager.ids(), vec!["b".to_string()]);
    }

    #[test]
    fn from_dir_enumerates_existing_session_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("s1.sqlite"), b"").unwrap();
        std::fs::write(dir.path().join("s2.sqlite"), b"").unwrap();
        std::fs::write(dir.path().join("not-a-session.txt"), b"x").unwrap();

        let manager = SessionManager::from_dir(dir.path());
        assert_eq!(manager.ids(), vec!["s1".to_string(), "s2".to_string()]);
    }

    #[tokio::test]
    async fn spawn_session_runs_one_complete_turn() {
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
        let agent = handle.agent.as_ref().expect("agent spawned");
        let mut rx = agent.subscribe();
        agent
            .send(AgentInput::UserMessage {
                content: json!({"type": "text", "text": "hi"}),
            })
            .await
            .expect("send");

        let mut saw_hello = false;
        loop {
            match tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
                Ok(Ok(AgentEvent::AgentEnd)) => break,
                Ok(Ok(AgentEvent::MessageUpdate { message, .. })) => {
                    if message.get("text").and_then(|t| t.as_str()) == Some("hello") {
                        saw_hello = true;
                    }
                }
                Ok(Ok(_)) => {}
                Ok(Err(_)) | Err(_) => break,
            }
        }
        assert!(saw_hello, "engine did not stream assistant content");
    }

    #[test]
    fn picker_moves_and_clamps() {
        let mut picker = Picker::new(vec!["a".to_string(), "b".to_string(), "c".to_string()]);
        assert_eq!(picker.selected(), Some(&"a".to_string()));
        picker.move_down();
        picker.move_down();
        picker.move_down();
        assert_eq!(picker.selected(), Some(&"c".to_string()));
        picker.move_up();
        picker.move_up();
        picker.move_up();
        picker.move_up();
        assert_eq!(picker.selected(), Some(&"a".to_string()));
    }

    #[test]
    fn empty_picker_has_no_selection() {
        let picker: Picker<String> = Picker::new(vec![]);
        assert!(picker.is_empty());
        assert_eq!(picker.selected(), None);
    }
}
