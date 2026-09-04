//! Session lifecycle: spawn, resume, and manage engine-backed sessions.
//!
//! This module owns everything a client (TUI, web, GUI) used to assemble by
//! hand: opening the SQLite stores, resolving provider/model from config,
//! building system + adapter prompts, registering builtin IO and MCP tools,
//! and spawning the `eta-core` agent. Clients only deal with
//! [`SessionHandle`]s and the [`SessionManager`] attach registry.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use eta_core::{
    Agent, AgentConfig, AgentDevEvent, AgentEvent, AgentId, AgentInput, Hooks, LoopManager,
    MemoryStore, SessionStorage, Tool,
};
use eta_llm::{Model, Provider};
use eta_sqlite_storage::{SqliteAgentStore, SqliteSessionStore, list_sessions_in};
use eta_system_prompts::DEFAULT_SYSTEM_PROMPT;

use crate::{build_adapter_system_prompt, configured_model, load_mcp_registry, mcp_tools};

/// Session KV key for the per-session model override.
const MODEL_KEY: &str = "eta.model";
/// Session KV key recording which agent owns the session.
const OWNER_KEY: &str = "eta.owner";

/// Persist the per-session model override (`/model` without global save).
pub async fn save_model(store: &dyn SessionStorage, model: &str) {
    store.set_state(MODEL_KEY, serde_json::json!(model)).await;
}

/// Read the per-session model override, if any.
pub async fn load_model(store: &dyn SessionStorage) -> Option<String> {
    store
        .get_state(MODEL_KEY)
        .await
        .and_then(|value| value.as_str().map(String::from))
}

/// Record which agent owns this session so a resume can restore it.
pub async fn save_owner(store: &dyn SessionStorage, owner: &str) {
    store.set_state(OWNER_KEY, serde_json::json!(owner)).await;
}

/// Read the owning agent's name recorded at spawn time.
pub async fn load_owner(store: &dyn SessionStorage) -> Option<String> {
    store
        .get_state(OWNER_KEY)
        .await
        .and_then(|value| value.as_str().map(String::from))
}

/// Coarse lifecycle label for display in session pickers.
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

/// A live or resumable session: its engine handle (if spawned), storage, and
/// metadata. Clients subscribe to `event_rx` / `dev_rx` and render; they never
/// touch providers or stores directly.
pub struct SessionHandle {
    pub agent: Option<Agent>,
    pub event_rx: Option<tokio::sync::broadcast::Receiver<AgentEvent>>,
    pub dev_rx: Option<tokio::sync::broadcast::Receiver<AgentDevEvent>>,
    pub loop_manager: Option<Arc<LoopManager>>,
    pub store: Arc<dyn SessionStorage>,
    pub meta: SessionMeta,
    /// Names of the tools registered at spawn time (for context display).
    pub tool_names: Vec<String>,
}

impl SessionHandle {
    /// Send input to the engine, if this session is spawned.
    pub async fn send(
        &self,
        input: AgentInput,
    ) -> Option<Result<(), tokio::sync::mpsc::error::SendError<AgentInput>>> {
        match self.agent.as_ref() {
            Some(agent) => Some(agent.send(input).await),
            None => None,
        }
    }

    /// Request cancellation of in-flight work.
    pub fn cancel(&self) {
        if let Some(agent) = self.agent.as_ref() {
            agent.cancel();
        }
    }

    pub fn is_spawned(&self) -> bool {
        self.agent.is_some()
    }
}

/// Why a spawn request could not be fulfilled. Clients map these onto their
/// own UX (e.g. the TUI opens the model picker on `NoModel`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpawnError {
    /// No model configured anywhere (config, env, or session override).
    NoModel,
    /// The configured `provider/model` id does not resolve to a provider.
    UnknownModel(String),
}

/// Parameters for spawning a brand-new session.
#[derive(Clone, Debug, Default)]
pub struct SpawnRequest {
    /// Owning agent name (also the memory-store file name).
    pub agent_name: String,
    /// Optional builtin persona to fold into the system prompt.
    pub persona: Option<String>,
    /// Optional explicit `provider/model`; falls back to config/env.
    pub model_id: Option<String>,
}

/// Everything needed to spawn one engine, already resolved.
///
/// Constructed by [`assemble`] from config + adapters; kept public so tests
/// can inject mock providers and in-memory stores through the same path the
/// real client uses.
pub struct SpawnPlan {
    pub session_id: String,
    pub agent_id: AgentId,
    pub provider: Arc<dyn Provider>,
    pub model: Model,
    pub store: Arc<dyn SessionStorage>,
    pub memory: Arc<dyn MemoryStore>,
    pub tools: Vec<Arc<dyn Tool>>,
    pub system_prompt: String,
    pub adapter_prompt: String,
    pub tool_names: Vec<String>,
    /// The concrete sqlite store, for time-travel and other raw access.
    pub sqlite: Arc<SqliteSessionStore>,
}

/// The builtin IO tools plus MCP tools for every configured server.
pub fn default_tools() -> (Vec<Arc<dyn Tool>>, Vec<String>) {
    let registry = load_mcp_registry();
    let mut tools = eta_io_tools::builtin_io_tools();
    tools.extend(mcp_tools(&registry));
    let names = tools.iter().map(|t| t.name().to_string()).collect();
    (tools, names)
}

fn open_session_store(session_id: &str) -> Arc<SqliteSessionStore> {
    let _ = std::fs::create_dir_all(eta_fs::sessions_dir());
    Arc::new(
        SqliteSessionStore::open(eta_fs::session_db(session_id))
            .unwrap_or_else(|_| SqliteSessionStore::in_memory()),
    )
}

fn open_agent_memory(agent_name: &str) -> Arc<dyn MemoryStore> {
    let _ = std::fs::create_dir_all(eta_fs::agents_dir());
    Arc::new(
        SqliteAgentStore::open(eta_fs::agent_db(agent_name))
            .unwrap_or_else(|_| SqliteAgentStore::in_memory()),
    )
}

fn system_prompt_for(persona: Option<&str>) -> String {
    let body = persona
        .and_then(|p| eta_system_prompts::builtin_personas().get(p).cloned())
        .unwrap_or_default();
    if body.is_empty() {
        DEFAULT_SYSTEM_PROMPT.to_string()
    } else {
        format!("{DEFAULT_SYSTEM_PROMPT}\n\n{body}")
    }
}

/// Assemble a [`SpawnPlan`] for a new session owned by `request.agent_name`.
pub async fn assemble_new(request: &SpawnRequest) -> Result<SpawnPlan, SpawnError> {
    let config = crate::load_config();
    let model_id = request
        .model_id
        .clone()
        .or_else(|| configured_model(&config))
        .ok_or(SpawnError::NoModel)?;
    let (provider, model) = crate::resolve_provider_model(&model_id, &config)
        .ok_or_else(|| SpawnError::UnknownModel(model_id.clone()))?;

    let session_id = uuid::Uuid::now_v7().to_string();
    let sqlite = open_session_store(&session_id);
    let store: Arc<dyn SessionStorage> = sqlite.clone();
    save_owner(store.as_ref(), &request.agent_name).await;
    if let Some(model) = request.model_id.as_deref() {
        save_model(store.as_ref(), model).await;
    }
    let memory = open_agent_memory(&request.agent_name);
    let (tools, tool_names) = default_tools();
    let adapter_prompt =
        build_adapter_system_prompt(&session_id, &request.agent_name, &model_id, &tool_names);
    Ok(SpawnPlan {
        session_id,
        agent_id: AgentId(request.agent_name.clone()),
        provider,
        model,
        store,
        memory,
        tools,
        system_prompt: system_prompt_for(request.persona.as_deref()),
        adapter_prompt,
        tool_names,
        sqlite,
    })
}

/// Assemble a [`SpawnPlan`] resuming an existing persisted session: owner and
/// per-session model override are restored from the session KV.
pub async fn assemble_resume(session_id: &str) -> Result<SpawnPlan, SpawnError> {
    let sqlite = open_session_store(session_id);
    let store: Arc<dyn SessionStorage> = sqlite.clone();
    let owner = load_owner(store.as_ref())
        .await
        .unwrap_or_else(|| session_id.to_string());
    let config = crate::load_config();
    let model_id = load_model(store.as_ref())
        .await
        .or_else(|| configured_model(&config))
        .ok_or(SpawnError::NoModel)?;
    let (provider, model) = crate::resolve_provider_model(&model_id, &config)
        .ok_or_else(|| SpawnError::UnknownModel(model_id.clone()))?;
    let memory = open_agent_memory(&owner);
    let (tools, tool_names) = default_tools();
    let adapter_prompt = build_adapter_system_prompt(session_id, &owner, &model_id, &tool_names);
    Ok(SpawnPlan {
        session_id: session_id.to_string(),
        agent_id: AgentId(owner),
        provider,
        model,
        store,
        memory,
        tools,
        system_prompt: DEFAULT_SYSTEM_PROMPT.to_string(),
        adapter_prompt,
        tool_names,
        sqlite,
    })
}

/// Assemble a plan that re-spawns an already-live session with a different
/// model (`/model`) or a different agent (`/agent`), reusing its store.
pub async fn assemble_respawn(
    session_id: &str,
    agent_name: &str,
    model_id: &str,
    store: Arc<dyn SessionStorage>,
) -> Result<SpawnPlan, SpawnError> {
    let config = crate::load_config();
    let (provider, model) = crate::resolve_provider_model(model_id, &config)
        .ok_or_else(|| SpawnError::UnknownModel(model_id.to_string()))?;
    let memory = open_agent_memory(agent_name);
    let (tools, tool_names) = default_tools();
    let adapter_prompt = build_adapter_system_prompt(session_id, agent_name, model_id, &tool_names);
    let sqlite = Arc::new(
        SqliteSessionStore::open(eta_fs::session_db(session_id))
            .unwrap_or_else(|_| SqliteSessionStore::in_memory()),
    );
    Ok(SpawnPlan {
        session_id: session_id.to_string(),
        agent_id: AgentId(agent_name.to_string()),
        provider,
        model,
        store,
        memory,
        tools,
        system_prompt: DEFAULT_SYSTEM_PROMPT.to_string(),
        adapter_prompt,
        tool_names,
        sqlite,
    })
}

/// Spawn one engine from a plan (1 agent : 1 session).
pub fn spawn(plan: SpawnPlan) -> SessionHandle {
    let meta_agent_id = plan.agent_id.clone();
    let agent = Agent::spawn(AgentConfig {
        agent_id: plan.agent_id,
        provider: plan.provider,
        model: plan.model,
        tools: plan.tools,
        hooks: Hooks::new(),
        store: plan.store.clone(),
        skill_store: None,
        memory_store: plan.memory,
        system_prompt: plan.system_prompt,
        adapter_system_prompt: plan.adapter_prompt,
        max_retries: 2,
    });
    let event_rx = agent.subscribe();
    let dev_rx = agent.subscribe_dev();
    let mut loop_manager = LoopManager::new(plan.store.clone(), agent.input_sender());
    loop_manager.with_dev(meta_agent_id.clone(), agent.dev_sender());
    SessionHandle {
        agent: Some(agent),
        event_rx: Some(event_rx),
        dev_rx: Some(dev_rx),
        loop_manager: Some(Arc::new(loop_manager)),
        store: plan.store,
        meta: SessionMeta {
            id: plan.session_id,
            agent_id: meta_agent_id,
            status: SessionStatus::Running,
            goal: None,
            turn_count: 0,
            last_activity: Instant::now(),
        },
        tool_names: plan.tool_names,
    }
}

/// The attach-model session registry. `current` is a pointer into `sessions`;
/// switching it re-points the client without restarting any running engine.
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

    /// Replace one session's engine while preserving every other registered
    /// session and the current attach pointer. Returns whether it existed.
    pub fn replace(&mut self, handle: SessionHandle) -> bool {
        let id = handle.meta.id.clone();
        let existed = self.sessions.contains_key(&id);
        self.sessions.insert(id, handle);
        existed
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

    /// Remove a session. Callers are responsible for cancelling its agent
    /// before dropping the handle.
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

    /// Enumerate persisted session files, registering an unspawned handle for
    /// each. Missing/unreadable files are skipped.
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
                    loop_manager: None,
                    store: Arc::new(store),
                    meta: SessionMeta {
                        id: id.clone(),
                        agent_id: AgentId(id.clone()),
                        status: SessionStatus::Empty,
                        goal: None,
                        turn_count: 0,
                        last_activity: Instant::now(),
                    },
                    tool_names: Vec::new(),
                });
            }
        }
        manager
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handle(id: &str) -> SessionHandle {
        SessionHandle {
            agent: None,
            event_rx: None,
            dev_rx: None,
            loop_manager: None,
            store: Arc::new(SqliteSessionStore::in_memory()),
            meta: SessionMeta {
                id: id.to_string(),
                agent_id: AgentId(id.to_string()),
                status: SessionStatus::Empty,
                goal: None,
                turn_count: 0,
                last_activity: Instant::now(),
            },
            tool_names: Vec::new(),
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
    fn replace_preserves_other_sessions_and_current() {
        let mut manager = SessionManager::new();
        manager.insert(handle("a"));
        manager.insert(handle("b"));
        manager.attach("b");
        assert!(manager.replace(handle("a")));
        assert_eq!(manager.current_id(), Some("b"));
        assert_eq!(manager.ids().len(), 2);
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
    async fn owner_and_model_kv_roundtrip() {
        let store = SqliteSessionStore::in_memory();
        assert_eq!(load_owner(&store).await, None);
        assert_eq!(load_model(&store).await, None);
        save_owner(&store, "dev").await;
        save_model(&store, "deepseek/chat").await;
        assert_eq!(load_owner(&store).await.as_deref(), Some("dev"));
        assert_eq!(load_model(&store).await.as_deref(), Some("deepseek/chat"));
    }
}
