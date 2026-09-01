//! # eta-core
//!
//! 单 agent 引擎:`Agent` + `Tool` + `drive_loop` + goal 续命 + loop 调度 + self-mgmt。
//!
//! 设计约束:
//! - 纯 trait + 纯逻辑,零 IO(runtime 用 tokio);
//! - 1 agent : 1 session,完全不感知 multi-agent;
//! - 只依赖 `eta-llm`。

#![doc = include_str!("../README.md")]

mod agent;
mod error;
mod hooks;
mod loop_detect;
mod loop_mgr;
mod store;
mod time;
mod tool;
mod types;

pub use agent::{Agent, AgentConfig};
pub use error::{AgentError, ToolError, classify_provider_error};
pub use hooks::{AgentHooks, Hooks};
pub use loop_detect::LoopDetector;
pub use loop_mgr::{LoopManager, LoopSpec, Trigger, TriggerRuntime, bootstrap_loops};
pub use store::{MemoryStore, SessionEntry, SessionState, SessionStorage, Skill, SkillStore};
pub use time::{DurationParseError, parse_duration};
pub use tool::{CancelToken, Tool};
pub use types::{
    AgentEvent, AgentId, AgentInput, ControlPlaneAction, ControlPlaneDecision, ControlPlanePrompt,
    GoalContinuationGate, GoalState, GoalStatus, ToolCall, ToolResult, TurnContext, TurnDriver,
};
