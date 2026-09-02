//! Observability events — the agent's dev stream, separate from the UI-facing
//! `AgentEvent` projection.
//!
//! `AgentEvent` is what the embedder renders; `AgentDevEvent` is what a debug
//! panel, log sink, or teach/self-evolution recorder consumes. It carries a
//! monotonic timestamp (so consumers can compute rates like tokens/sec), the
//! source agent, a `category` + `action`, and a weak-typed `data` payload.

use std::time::Instant;

use serde_json::Value;

use crate::types::AgentId;

/// Category constants for the dev event stream.
pub mod dev_category {
    /// Agent lifecycle (spawn / stop).
    pub const LIFECYCLE: &str = "lifecycle";
    /// Turn boundaries.
    pub const TURN: &str = "turn";
    /// Token usage deltas (input / output / cache).
    pub const USAGE: &str = "usage";
    /// The assembled system prompt for a step.
    pub const PROMPT: &str = "prompt";
    /// Compaction of the context.
    pub const COMPACTION: &str = "compaction";
    /// Loop registration / firing / suppression.
    pub const LOOP: &str = "loop";
    /// Goal lifecycle changes.
    pub const GOAL: &str = "goal";
    /// Memory (evo) edits.
    pub const MEMORY: &str = "memory";
    /// Preferred-skill edits.
    pub const SKILL: &str = "skill";
    /// Todo (current-tasks) edits.
    pub const TODO: &str = "todo";
    /// Session KV state edits.
    pub const STATE: &str = "state";
    /// Tool execution (start / end / validation / permission).
    pub const TOOL: &str = "tool";
    /// Retry / error paths.
    pub const RETRY: &str = "retry";
    /// `ask_user` round-trips.
    pub const ASK_USER: &str = "ask_user";
}

/// An observability event emitted on the agent's dev stream.
#[derive(Clone, Debug)]
pub struct AgentDevEvent {
    /// Monotonic timestamp (for token/sec and other rate computations).
    pub ts: Instant,
    /// Source agent.
    pub agent_id: AgentId,
    /// Event category (see [`dev_category`]).
    pub category: String,
    /// Action within the category (e.g. "start", "end", "set", "add").
    pub action: String,
    /// Structured payload.
    pub data: Value,
}

impl AgentDevEvent {
    pub fn new(agent_id: AgentId, category: &str, action: &str, data: Value) -> Self {
        Self {
            ts: Instant::now(),
            agent_id,
            category: category.to_string(),
            action: action.to_string(),
            data,
        }
    }
}
