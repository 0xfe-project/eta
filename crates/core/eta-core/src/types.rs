//! Core data types: identity, channels, goals, permissions, hook context.

use serde::{Deserialize, Serialize};

/// Stable per-agent identity (used for GUI coloring / message attribution).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AgentId(pub String);

impl std::fmt::Display for AgentId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// External input to the agent.
#[derive(Clone, Debug)]
pub enum AgentInput {
    /// Multi-modal content; queued until the current turn ends.
    UserMessage {
        content: serde_json::Value,
    },
    /// Interrupt the current turn and inject new instructions (keeps context).
    Steer {
        message: serde_json::Value,
    },
    /// From the loop scheduler: interrupt + inject a loop prompt.
    Loop {
        loop_id: String,
        prompt: serde_json::Value,
    },
    Resume,
    Abort {
        reason: String,
    },
    SetGoal {
        objective: String,
    },
    PauseGoal,
    ResumeGoal,
    ClearGoal,
    /// Manually compact the conversation prefix now (outside turn boundary).
    Compact,
    Custom(serde_json::Value),
}

/// An answer to a pending `ask_user` question, sent over the agent's dedicated
/// answer channel (not through `AgentInput`).
#[derive(Clone, Debug)]
pub struct AskUserAnswer {
    pub tool_call_id: String,
    pub answer: serde_json::Value,
}

/// Internal driver queue items.
#[derive(Clone, Debug)]
pub enum TurnDriver {
    UserMessage(serde_json::Value),
    GoalContinuation,
    Resume,
}

/// Events emitted by the agent to the embedder.
#[derive(Clone, Debug)]
pub enum AgentEvent {
    TurnStart {
        request_id: String,
    },
    TurnEnd {
        request_id: String,
    },
    MessageStart {
        agent_id: AgentId,
        message: serde_json::Value,
    },
    MessageUpdate {
        agent_id: AgentId,
        message: serde_json::Value,
    },
    MessageEnd {
        agent_id: AgentId,
        message: serde_json::Value,
    },
    ToolExecutionStart {
        id: String,
        name: String,
        args: serde_json::Value,
    },
    ToolExecutionEnd {
        id: String,
        result: serde_json::Value,
        is_error: bool,
    },
    GoalStateChange {
        status: GoalStatus,
    },
    Compaction {
        tokens_before: u64,
    },
    LoopDetected,
    AskUserStarted {
        req_id: String,
        question: serde_json::Value,
    },
    AgentEnd,
    Custom(serde_json::Value),
}

/// A context snapshot handed to hooks.
#[derive(Clone, Debug)]
pub struct TurnContext {
    pub agent_id: AgentId,
    pub request_id: String,
    pub messages_since_start: usize,
}

/// A tool call the model issued.
#[derive(Clone, Debug)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// A tool result.
#[derive(Clone, Debug)]
pub struct ToolResult {
    pub id: String,
    pub value: serde_json::Value,
    pub is_error: bool,
}

/// Whether goal self-continuation is managed by the engine or delegated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GoalContinuationGate {
    AutoContinue,
    Delegated,
}

/// Goal lifecycle status.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum GoalStatus {
    Active,
    Paused,
    Achieved,
    Cancelled,
}

/// The agent's current goal + anti-spin bookkeeping.
#[derive(Clone, Debug)]
pub struct GoalState {
    pub objective: String,
    pub status: GoalStatus,
    pub round_count: u32,
    pub idle_without_tools: u32,
    pub active_duration_ms: u64,
    pub last_accrued_at: Option<std::time::Instant>,
    pub blocked_reason: Option<String>,
}

impl GoalState {
    pub fn new(objective: impl Into<String>) -> Self {
        Self {
            objective: objective.into(),
            status: GoalStatus::Active,
            round_count: 0,
            idle_without_tools: 0,
            active_duration_ms: 0,
            last_accrued_at: None,
            blocked_reason: None,
        }
    }

    /// Guidelines injected into the context while pursuing this goal.
    pub fn build_goal_pursuit_guidelines(&self) -> String {
        eta_system_prompts::goal_pursuit_guidelines(&self.objective)
    }
}

/// A todo item in the agent's current-tasks plan.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoItem {
    pub id: String,
    /// Optional on update — an empty `content` keeps the existing value.
    #[serde(default)]
    pub content: String,
    pub status: TodoStatus,
}

/// Todo item status.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

/// Memory classification.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    /// User's hard requirement (e.g. "never use nextjs again").
    Decision,
    /// User's weaker preference (e.g. "prefer sqlite over pg").
    Preference,
    /// Lesson from tool failures or negative feedback.
    Lesson,
}

/// A single memory entry (`{ "type": ..., "content": ... }`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryEntry {
    #[serde(rename = "type")]
    pub kind: MemoryKind,
    pub content: String,
}
