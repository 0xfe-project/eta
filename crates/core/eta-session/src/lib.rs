#![doc = include_str!("../README.md")]

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use eta_llm::{Context, ToolSchema};

pub use eta_core::{SessionEntry, SessionState, SessionStorage, entry_kind};

mod cache;
mod progressive_disclosure;

pub use cache::{ContextCache, blob_id};
pub use progressive_disclosure::{
    MAX_TRUNCATED_DESCRIPTION_LENGTH, McpServerDir, assemble_system_prompt, render_mcp_directory,
    render_skills_catalog,
};

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

// ── C1: build_context (replay + compaction) ─────────────────────────────────

/// Assemble the LLM context by replaying the append-only entries.
///
/// Handles compaction: the last `compaction` entry contributes a summary and
/// marks `first_kept_entry_id`; entries before it are skipped (they were
/// summarized), so a `--resume` never loses the pre-compaction tail.
pub fn build_context(
    entries: &[SessionEntry],
    system_prompt: &str,
    tools: &[ToolSchema],
) -> Context {
    // Find the last compaction entry.
    let mut first_kept = 0u64;
    let mut summary: Option<String> = None;
    for entry in entries {
        if entry.kind == entry_kind::COMPACTION {
            first_kept = entry
                .data
                .get("first_kept_entry_id")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            summary = entry
                .data
                .get("summary")
                .and_then(|v| v.as_str())
                .map(String::from);
        }
    }

    let mut messages: Vec<serde_json::Value> = Vec::new();
    if let Some(s) = summary {
        messages.push(serde_json::json!({
            "role": "user",
            "content": format!("[Previous conversation summary]\n{s}"),
        }));
    }
    for entry in entries {
        if entry.id < first_kept {
            continue; // summarized prefix
        }
        if is_message_kind(&entry.kind) {
            messages.push(entry.data.clone());
        }
    }

    Context {
        system_prompt: Some(system_prompt.to_string()),
        messages,
        tools: tools.to_vec(),
    }
}

fn is_message_kind(kind: &str) -> bool {
    matches!(
        kind,
        entry_kind::USER_MESSAGE
            | entry_kind::ASSISTANT_MESSAGE
            | entry_kind::TOOL_RESULT
            | entry_kind::ANSWER
    )
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
