#![doc = include_str!("../README.md")]

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// A context plugin that renders a static block of "meta" context into the
/// system prompt (workspace identity, skills catalog, memory, user info).
pub trait ContextPlugin: Send + Sync {
    fn id(&self) -> &str;
    fn render(&self) -> String;
}

/// A loadable skill.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub content: String,
}

/// Storage-agnostic skill catalog.
#[async_trait]
pub trait SkillStore: Send + Sync {
    async fn list(&self) -> Vec<Skill>;
    async fn load(&self, name: &str) -> Option<Skill>;
}

/// Storage-agnostic cross-session memory (key/value).
#[async_trait]
pub trait MemoryStore: Send + Sync {
    async fn put(&self, key: &str, value: &str);
    async fn get_all(&self) -> Vec<(String, String)>;
}
