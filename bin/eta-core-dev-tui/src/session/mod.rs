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

use eta_core::{Agent, SessionStorage};
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
    pub status: SessionStatus,
    pub goal: Option<String>,
    pub turn_count: u64,
    pub last_activity: Instant,
}

/// A single session: its engine handle (if spawned), store, and metadata.
pub struct SessionHandle {
    pub agent: Option<Agent>,
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
                    store: Arc::new(store),
                    meta: SessionMeta {
                        id: id.clone(),
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

#[cfg(test)]
mod tests {
    use super::{SessionHandle, SessionManager, SessionMeta, SessionStatus};
    use eta_sqlite_storage::SqliteSessionStore;
    use std::sync::Arc;
    use std::time::Instant;

    fn handle(id: &str) -> SessionHandle {
        SessionHandle {
            agent: None,
            store: Arc::new(SqliteSessionStore::in_memory()),
            meta: SessionMeta {
                id: id.to_string(),
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
}
