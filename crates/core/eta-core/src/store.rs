//! Session / memory / skill seam traits — the storage contracts the engine plugs into.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// A single append-only transcript entry in a session.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionEntry {
    pub id: u64,
    pub kind: String,
    pub data: serde_json::Value,
}

/// Strong-typed envelope around session state (content is opaque `Value`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionState {
    /// uuidv7, unique per session.
    pub id: String,
    /// append-only stable prefix.
    pub prefix: serde_json::Value,
    /// granular turn boundaries.
    pub turns: serde_json::Value,
    pub summary: Option<String>,
    pub summary_archives: Vec<String>,
    pub compaction_epoch: u64,
    pub prefix_invalidated: bool,
    pub usage: serde_json::Value,
    pub kv_state: serde_json::Value,
    pub goal: serde_json::Value,
    pub custom: serde_json::Value,
}

/// Storage-agnostic session persistence (seam trait; implemented in adapters).
///
/// The store is the single source of truth; everything is append-only here and
/// the concrete backend (e.g. SQLite) lives in `eta-sqlite-storage`.
#[async_trait]
pub trait SessionStorage: Send + Sync {
    async fn load(&self) -> Vec<SessionEntry>;
    async fn append(&self, entry: SessionEntry);
    async fn checkpoint(&self, state: serde_json::Value);

    /// Search entries matching `query`, returning matching entry ids.
    async fn search(&self, query: &str) -> Vec<u64>;

    // Session KV state — persisted by the storage adapter.

    async fn get_state(&self, key: &str) -> Option<serde_json::Value>;
    async fn set_state(&self, key: &str, value: serde_json::Value);
    async fn delete_state(&self, key: &str);
    async fn list_state_keys(&self) -> Vec<String>;

    /// All session ids in the backend. Single-session stores return an empty
    /// vec; the multi-session backend (e.g. SQLite) overrides this.
    async fn list_sessions(&self) -> Vec<String> {
        Vec::new()
    }
}

/// A skill catalog entry (injected into the `<skills>` section of the system prompt).
///
/// A skill is just a standard: a folder containing a `SKILL.md` that may point
/// at a bunch of local paths. The catalog only carries `name` + `description`;
/// the body is read on demand by the model via its read tool.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub description: String,
}

/// Storage-agnostic skill catalog (seam trait; implemented per-agent by `eta-agent`).
#[async_trait]
pub trait SkillStore: Send + Sync {
    /// Search the catalog (name + description) by query.
    async fn search(&self, query: &str) -> Vec<Skill>;
    /// Return the skill body as a string; the model figures out what to do with it.
    async fn load(&self, name: &str) -> Option<String>;
}

/// Storage-agnostic agent memory (seam trait; per-agent, just strings — not part
/// of the session).
#[async_trait]
pub trait MemoryStore: Send + Sync {
    async fn get_all(&self) -> Vec<String>;
    async fn put(&self, memory: String);
}
