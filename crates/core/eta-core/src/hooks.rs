//! Lifecycle / decision extension points (`AgentHooks`) and their registry.

use std::sync::Arc;

use async_trait::async_trait;
use eta_llm::Context;

use crate::types::{
    AgentId, AgentInput, ControlPlaneDecision, ControlPlanePrompt, GoalContinuationGate, GoalState,
    ToolCall, ToolResult, TurnContext,
};

/// Lifecycle / decision extension points. Every method has a default no-op so
/// "not implementing = unchanged behavior" (except `on_control_plane_prompt`,
/// which defaults to `Deny`).
#[async_trait]
pub trait AgentHooks: Send + Sync {
    fn on_spawn(&self, _agent: &AgentId) {}
    fn on_stop(&self, _agent: &AgentId) {}
    fn on_turn_start(&self, _ctx: &TurnContext) {}
    fn on_turn_end(&self, _ctx: &TurnContext) {}
    fn should_stop_after_turn(&self, _ctx: &TurnContext) -> bool {
        false
    }
    fn prepare_next_turn(&self, _ctx: &mut TurnContext) {}
    fn on_queue_in(&self, _ev: &AgentInput) {}
    fn on_steer(&self, _ctx: &TurnContext) {}
    fn before_tool_call(&self, _call: &ToolCall) {}
    fn after_tool_call(&self, _call: &ToolCall, _result: &ToolResult) {}
    fn transform_context(&self, _context: &mut Context) {}
    fn before_compaction(&self, _ctx: &TurnContext) {}
    fn on_compaction(&self, _ctx: &TurnContext) {}
    fn on_goal_change(&self, _goal: &GoalState) {}
    fn goal_continuation_gate(&self) -> GoalContinuationGate {
        GoalContinuationGate::AutoContinue
    }
    async fn on_control_plane_prompt(&self, _prompt: &ControlPlanePrompt) -> ControlPlaneDecision {
        ControlPlaneDecision::Deny {
            reason: "denied by default (fail-closed)".into(),
        }
    }
}

/// A registry of hooks. Every hook point dispatches to each registered hook in
/// registration order.
#[derive(Default)]
pub struct Hooks {
    inner: Vec<Arc<dyn AgentHooks>>,
}

impl Hooks {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, hook: Arc<dyn AgentHooks>) {
        self.inner.push(hook);
    }

    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    pub fn on_spawn(&self, agent: &AgentId) {
        for h in &self.inner {
            h.on_spawn(agent);
        }
    }
    pub fn on_stop(&self, agent: &AgentId) {
        for h in &self.inner {
            h.on_stop(agent);
        }
    }
    pub fn on_turn_start(&self, ctx: &TurnContext) {
        for h in &self.inner {
            h.on_turn_start(ctx);
        }
    }
    pub fn on_turn_end(&self, ctx: &TurnContext) {
        for h in &self.inner {
            h.on_turn_end(ctx);
        }
    }
    pub fn should_stop_after_turn(&self, ctx: &TurnContext) -> bool {
        self.inner.iter().any(|h| h.should_stop_after_turn(ctx))
    }
    pub fn prepare_next_turn(&self, ctx: &mut TurnContext) {
        for h in &self.inner {
            h.prepare_next_turn(ctx);
        }
    }
    pub fn on_queue_in(&self, ev: &AgentInput) {
        for h in &self.inner {
            h.on_queue_in(ev);
        }
    }
    pub fn on_steer(&self, ctx: &TurnContext) {
        for h in &self.inner {
            h.on_steer(ctx);
        }
    }
    pub fn before_tool_call(&self, call: &ToolCall) {
        for h in &self.inner {
            h.before_tool_call(call);
        }
    }
    pub fn after_tool_call(&self, call: &ToolCall, result: &ToolResult) {
        for h in &self.inner {
            h.after_tool_call(call, result);
        }
    }
    pub fn transform_context(&self, context: &mut Context) {
        for h in &self.inner {
            h.transform_context(context);
        }
    }
    pub fn before_compaction(&self, ctx: &TurnContext) {
        for h in &self.inner {
            h.before_compaction(ctx);
        }
    }
    pub fn on_compaction(&self, ctx: &TurnContext) {
        for h in &self.inner {
            h.on_compaction(ctx);
        }
    }
    pub fn on_goal_change(&self, goal: &GoalState) {
        for h in &self.inner {
            h.on_goal_change(goal);
        }
    }
    pub fn goal_continuation_gate(&self) -> GoalContinuationGate {
        if self
            .inner
            .iter()
            .any(|h| h.goal_continuation_gate() == GoalContinuationGate::Delegated)
        {
            GoalContinuationGate::Delegated
        } else {
            GoalContinuationGate::AutoContinue
        }
    }
    pub async fn on_control_plane_prompt(
        &self,
        prompt: &ControlPlanePrompt,
    ) -> ControlPlaneDecision {
        for h in &self.inner {
            if let ControlPlaneDecision::Deny { reason } = h.on_control_plane_prompt(prompt).await {
                return ControlPlaneDecision::Deny { reason };
            }
        }
        ControlPlaneDecision::Allow
    }
}
