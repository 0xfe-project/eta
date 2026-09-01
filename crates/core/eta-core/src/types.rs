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
    /// Answer to a pending `ask_user`.
    Answer {
        tool_call_id: String,
        answer: serde_json::Value,
    },
    Custom(serde_json::Value),
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

/// What the model wants to do that requires authorization.
#[derive(Clone, Debug)]
pub enum ControlPlaneAction {
    ExecuteTool,
    CreateAgent,
    SendToAgent,
    Custom(String),
}

/// A permission gate request (fail-closed).
#[derive(Clone, Debug)]
pub struct ControlPlanePrompt {
    pub request_id: String,
    pub action: ControlPlaneAction,
    pub tool_call: Option<ToolCall>,
    pub context: serde_json::Value,
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

/// A permission decision.
#[derive(Clone, Debug)]
pub enum ControlPlaneDecision {
    Allow,
    Deny { reason: String },
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
    pub continuation_count: u32,
    pub idle_without_tools: u32,
    pub blocked_reason: Option<String>,
}

impl GoalState {
    pub fn new(objective: impl Into<String>) -> Self {
        Self {
            objective: objective.into(),
            status: GoalStatus::Active,
            continuation_count: 0,
            idle_without_tools: 0,
            blocked_reason: None,
        }
    }
}
