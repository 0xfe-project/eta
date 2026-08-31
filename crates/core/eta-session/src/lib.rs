#![doc = include_str!("../README.md")]

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// A single transcript entry in a session.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionEntry {
    pub id: u64,
    pub kind: String,
    pub data: serde_json::Value,
}

/// Storage-agnostic session persistence.
///
/// Implementations choose the backend (SQLite, JSONL, IndexedDB, ...). The
/// trait makes no assumption about the underlying format or platform.
#[async_trait]
pub trait SessionStorage: Send + Sync {
    async fn load(&self) -> Vec<SessionEntry>;
    async fn append(&self, entry: SessionEntry);
    async fn checkpoint(&self, state: serde_json::Value);
}
