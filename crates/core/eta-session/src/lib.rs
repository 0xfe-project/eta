#![doc = include_str!("../README.md")]

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use eta_llm::{Context, ToolSchema};

pub use eta_core::{SessionEntry, SessionState, SessionStorage};

mod progressive_disclosure;

pub use progressive_disclosure::{MAX_TRUNCATED_DESCRIPTION_LENGTH, render_skills_catalog};

// ── C1: in-memory SessionStorage implementation ─────────────────────────────

/// In-memory `SessionStorage` implementation — the reference impl used in tests
/// and as a fallback. The durable SQLite backend lives in `eta-sqlite-storage`.
#[derive(Default)]
pub struct MemorySessionStore {
    entries: Mutex<Vec<SessionEntry>>,
    kv: Mutex<serde_json::Map<String, serde_json::Value>>,
}

#[async_trait]
impl SessionStorage for MemorySessionStore {
    async fn load(&self) -> Vec<SessionEntry> {
        self.entries.lock().unwrap().clone()
    }
    async fn append(&self, entry: SessionEntry) {
        self.entries.lock().unwrap().push(entry);
    }
    async fn checkpoint(&self, _state: serde_json::Value) {}
    async fn search(&self, _query: &str) -> Vec<u64> {
        vec![]
    }
    async fn get_state(&self, key: &str) -> Option<serde_json::Value> {
        self.kv.lock().unwrap().get(key).cloned()
    }
    async fn set_state(&self, key: &str, value: serde_json::Value) {
        self.kv.lock().unwrap().insert(key.to_string(), value);
    }
    async fn delete_state(&self, key: &str) {
        self.kv.lock().unwrap().remove(key);
    }
    async fn list_state_keys(&self) -> Vec<String> {
        self.kv.lock().unwrap().keys().cloned().collect()
    }
}

// ── C2: context assembly ─────────────────────────────────────────────────────

/// Assemble the LLM context for a turn.
///
/// Stable block (system prompt) + messages + tools. Progressive disclosure
/// (skills / mcp-tool directories with 4-level degradation) is layered on top
/// of `system_prompt` by the caller — this keeps the core assembly explicit.
pub fn build_context(
    system_prompt: &str,
    messages: &[serde_json::Value],
    tools: &[ToolSchema],
) -> Context {
    Context {
        system_prompt: Some(system_prompt.to_string()),
        messages: messages.to_vec(),
        tools: tools.to_vec(),
    }
}

// ── C4: git-like time travel ─────────────────────────────────────────────────

pub type CommitId = u64;
pub type BranchId = String;

#[derive(Clone, Debug, PartialEq)]
pub struct CommitInfo {
    pub id: CommitId,
    pub parents: Vec<CommitId>,
    pub message: String,
}

#[derive(Clone, Debug)]
struct Commit {
    info: CommitInfo,
    snapshot: serde_json::Value,
}

/// A commit DAG + branch pointers over full `SessionState` snapshots.
#[derive(Default)]
pub struct BranchManager {
    commits: Vec<Commit>,
    branches: HashMap<BranchId, CommitId>,
    head: Option<CommitId>,
    current: serde_json::Value,
    next_id: CommitId,
}

impl BranchManager {
    pub fn new() -> Self {
        Self {
            current: serde_json::Value::Null,
            ..Default::default()
        }
    }

    pub fn current(&self) -> &serde_json::Value {
        &self.current
    }

    pub fn set_current(&mut self, snapshot: serde_json::Value) {
        self.current = snapshot;
    }

    /// New branch pointing at the current HEAD (does not copy).
    pub fn fork(&mut self, name: &str) -> BranchId {
        self.branches
            .insert(name.to_string(), self.head.unwrap_or(0));
        name.to_string()
    }

    /// Snapshot the current state into a new commit.
    pub fn commit(&mut self, message: &str) -> CommitId {
        let id = self.next_id;
        self.next_id += 1;
        let parents = self.head.into_iter().collect::<Vec<_>>();
        let commit = Commit {
            info: CommitInfo {
                id,
                parents,
                message: message.to_string(),
            },
            snapshot: self.current.clone(),
        };
        self.commits.push(commit);
        self.head = Some(id);
        id
    }

    /// Checkout a branch name or commit id, restoring its snapshot.
    pub fn checkout(&mut self, target: &str) -> Option<()> {
        let commit_id = target
            .parse::<CommitId>()
            .ok()
            .or_else(|| self.branches.get(target).copied())?;
        self.restore(commit_id)
    }

    /// Rollback to a specific commit.
    pub fn rollback(&mut self, to: CommitId) -> Option<()> {
        self.restore(to)
    }

    fn restore(&mut self, id: CommitId) -> Option<()> {
        let commit = self.commits.iter().find(|c| c.info.id == id)?;
        self.current = commit.snapshot.clone();
        self.head = Some(id);
        Some(())
    }

    /// Commit log along the first-parent chain from HEAD.
    pub fn history(&self) -> Vec<CommitInfo> {
        let mut out = Vec::new();
        let mut cur = self.head;
        while let Some(id) = cur {
            match self.commits.iter().find(|c| c.info.id == id) {
                Some(c) => {
                    out.push(c.info.clone());
                    cur = c.info.parents.first().copied();
                }
                None => break,
            }
        }
        out
    }

    /// Merge another branch into HEAD (two-parent commit).
    pub fn merge(&mut self, other: &str) -> Option<CommitId> {
        let other_head = self.branches.get(other).copied()?;
        let id = self.next_id;
        self.next_id += 1;
        let commit = Commit {
            info: CommitInfo {
                id,
                parents: vec![self.head?, other_head],
                message: format!("merge {other}"),
            },
            snapshot: self.current.clone(),
        };
        self.commits.push(commit);
        self.head = Some(id);
        Some(id)
    }

    /// Substring search over commit snapshots (SQLite uses BM25/FTS5).
    pub fn search(&self, query: &str) -> Vec<CommitId> {
        self.commits
            .iter()
            .filter(|c| c.snapshot.to_string().contains(query))
            .map(|c| c.info.id)
            .collect()
    }
}
