//! The agent engine: channels, the drive loop, and the retry / tool pipeline.

use std::sync::Arc;

use tokio::sync::mpsc;
use tokio_stream::StreamExt;

use eta_llm::{Context, Event, Model, Provider, ProviderError, StopReason, ToolSchema, Usage};

use crate::error::classify_provider_error;
use crate::hooks::Hooks;
use crate::loop_detect::LoopDetector;
use crate::store::SessionStorage;
use crate::tool::{CancelToken, Tool, builtin_state_tools};
use crate::types::{
    AgentEvent, AgentId, AgentInput, ControlPlaneAction, ControlPlaneDecision, ControlPlanePrompt,
    GoalContinuationGate, GoalState, GoalStatus, ToolCall, ToolResult, TurnContext,
};

/// Detects anti-spin: 3 consecutive tool-free turns auto-pauses the goal.
const ANTI_SPIN_LIMIT: u32 = 3;

/// Configuration for a single agent instance.
pub struct AgentConfig {
    pub agent_id: AgentId,
    pub provider: Arc<dyn Provider>,
    pub model: Model,
    pub tools: Vec<Arc<dyn Tool>>,
    pub hooks: Hooks,
    pub store: Arc<dyn SessionStorage>,
    pub system_prompt: String,
    pub max_retries: usize,
}

/// A handle to a running agent.
pub struct Agent {
    input: mpsc::Sender<AgentInput>,
    output: mpsc::Receiver<AgentEvent>,
    cancel: CancelToken,
}

impl Agent {
    /// Spawn the agent's background loop and return a handle to it.
    pub fn spawn(mut cfg: AgentConfig) -> Self {
        let (input_tx, input_rx) = mpsc::channel(256);
        let (output_tx, output_rx) = mpsc::channel(256);
        let cancel = CancelToken::new();

        // Builtin state tools always attach to the session store.
        cfg.tools.extend(builtin_state_tools(cfg.store.clone()));

        let mut runtime = AgentRuntime {
            cfg,
            messages: Vec::new(),
            usage: Usage::default(),
            goal: None,
            loop_detector: LoopDetector::new(),
            pending_ask_user: None,
            request_counter: 0,
            input_rx,
            output_tx,
            cancel: cancel.clone(),
        };

        tokio::spawn(async move {
            runtime.run().await;
        });

        Agent {
            input: input_tx,
            output: output_rx,
            cancel,
        }
    }

    /// Send an input into the agent's queue.
    pub async fn send(&self, input: AgentInput) -> Result<(), mpsc::error::SendError<AgentInput>> {
        self.input.send(input).await
    }

    /// Receive the next event from the agent.
    pub async fn recv(&mut self) -> Option<AgentEvent> {
        self.output.recv().await
    }

    /// Cancel the agent.
    pub fn cancel(&self) {
        self.cancel.cancel();
    }
}

/// The background driver loop.
struct AgentRuntime {
    cfg: AgentConfig,
    messages: Vec<serde_json::Value>,
    usage: Usage,
    goal: Option<GoalState>,
    loop_detector: LoopDetector,
    pending_ask_user: Option<String>,
    request_counter: u64,
    input_rx: mpsc::Receiver<AgentInput>,
    output_tx: mpsc::Sender<AgentEvent>,
    cancel: CancelToken,
}

#[derive(Clone, Copy, Debug)]
struct TurnOutcome {
    had_tools: bool,
}

impl AgentRuntime {
    async fn run(&mut self) {
        let agent_id = self.cfg.agent_id.clone();
        self.cfg.hooks.on_spawn(&agent_id);

        while !self.cancel.is_cancelled() {
            let Some(input) = self.input_rx.recv().await else {
                break;
            };
            self.cfg.hooks.on_queue_in(&input);

            match input {
                AgentInput::UserMessage { content } => {
                    self.messages
                        .push(serde_json::json!({ "role": "user", "content": content }));
                    self.run_turn_chain().await;
                }
                AgentInput::Steer { message } => {
                    self.cfg.hooks.on_steer(&TurnContext {
                        agent_id: agent_id.clone(),
                        request_id: String::new(),
                        messages_since_start: self.messages.len(),
                    });
                    self.messages
                        .push(serde_json::json!({ "role": "user", "content": message }));
                    self.run_turn_chain().await;
                }
                AgentInput::Loop { loop_id: _, prompt } => {
                    self.messages
                        .push(serde_json::json!({ "role": "user", "content": prompt }));
                    self.run_turn_chain().await;
                }
                AgentInput::SetGoal { objective } => {
                    self.goal = Some(GoalState::new(objective));
                    self.emit_goal_change();
                }
                AgentInput::PauseGoal => {
                    if let Some(g) = &mut self.goal {
                        g.status = GoalStatus::Paused;
                        self.emit_goal_change();
                    }
                }
                AgentInput::ResumeGoal => {
                    if let Some(g) = &mut self.goal {
                        g.status = GoalStatus::Active;
                        self.emit_goal_change();
                    }
                }
                AgentInput::ClearGoal => {
                    if let Some(g) = &mut self.goal {
                        g.status = GoalStatus::Cancelled;
                        self.emit_goal_change();
                    }
                    self.goal = None;
                }
                AgentInput::Answer {
                    tool_call_id,
                    answer,
                } => {
                    if self.pending_ask_user.as_deref() == Some(&tool_call_id) {
                        self.pending_ask_user = None;
                        self.messages.push(serde_json::json!({
                            "role": "tool",
                            "tool_call_id": tool_call_id,
                            "content": answer,
                        }));
                        self.run_turn_chain().await;
                    }
                }
                AgentInput::Abort { reason } => {
                    let _ = reason;
                    break;
                }
                AgentInput::Resume | AgentInput::Custom(_) => {}
            }
        }

        self.cfg.hooks.on_stop(&agent_id);
        let _ = self.output_tx.send(AgentEvent::AgentEnd).await;
    }

    fn emit_goal_change(&self) {
        if let Some(g) = &self.goal {
            let _ = self
                .output_tx
                .try_send(AgentEvent::GoalStateChange { status: g.status });
            self.cfg.hooks.on_goal_change(g);
        }
    }

    /// Run turns until no tool result or goal continuation is pending.
    async fn run_turn_chain(&mut self) {
        loop {
            if self.cancel.is_cancelled() {
                break;
            }
            let outcome = self.run_turn().await;

            // Anti-spin bookkeeping: 3 consecutive tool-free turns pause the goal.
            let mut paused = false;
            if let Some(g) = &mut self.goal {
                if outcome.had_tools {
                    g.idle_without_tools = 0;
                } else {
                    g.idle_without_tools += 1;
                    if g.idle_without_tools >= ANTI_SPIN_LIMIT {
                        g.status = GoalStatus::Paused;
                        paused = true;
                    }
                }
            }
            if paused {
                self.emit_goal_change();
            }

            // Feed tool results back (had_tools) or continue the goal.
            if outcome.had_tools {
                continue;
            }
            if self.should_continue_goal() {
                if let Some(g) = &mut self.goal {
                    g.continuation_count += 1;
                }
                continue;
            }
            break;
        }
    }

    fn should_continue_goal(&self) -> bool {
        if self.cfg.hooks.goal_continuation_gate() != GoalContinuationGate::AutoContinue {
            return false;
        }
        matches!(
            self.goal.as_ref().map(|g| g.status),
            Some(GoalStatus::Active)
        )
    }

    async fn run_turn(&mut self) -> TurnOutcome {
        let agent_id = self.cfg.agent_id.clone();
        self.request_counter += 1;
        let request_id = format!("req_{}", self.request_counter);

        let tool_schemas: Vec<ToolSchema> = self
            .cfg
            .tools
            .iter()
            .map(|t| ToolSchema {
                name: t.name().to_string(),
                description: t.description().to_string(),
                schema: t.schema(),
            })
            .collect();

        let mut context = Context {
            system_prompt: Some(self.cfg.system_prompt.clone()),
            messages: self.messages.clone(),
            tools: tool_schemas,
        };
        self.cfg.hooks.transform_context(&mut context);

        let turn_ctx = TurnContext {
            agent_id: agent_id.clone(),
            request_id: request_id.clone(),
            messages_since_start: self.messages.len(),
        };

        self.cfg.hooks.on_turn_start(&turn_ctx);
        let _ = self
            .output_tx
            .send(AgentEvent::TurnStart {
                request_id: request_id.clone(),
            })
            .await;

        let step = self.run_step_with_retry(&context).await;

        self.cfg.hooks.on_turn_end(&turn_ctx);
        let _ = self
            .output_tx
            .send(AgentEvent::TurnEnd {
                request_id: request_id.clone(),
            })
            .await;

        TurnOutcome {
            had_tools: step.had_tools,
        }
    }

    /// One provider step + the three retry paths (error / truncation / empty /
    /// single-message loop).
    async fn run_step_with_retry(&mut self, context: &Context) -> StepResult {
        let max_retries = self.cfg.max_retries;
        let mut retries = 0usize;

        loop {
            let step = self.run_step(context).await;

            // Mid-stream / setup error → retry (retriable only).
            if let Some(err) = &step.error {
                if retries < max_retries && classify_provider_error(err).is_retryable() {
                    retries += 1;
                    self.messages.push(
                        serde_json::json!({ "role": "user", "content": "[continuation] continue" }),
                    );
                    continue;
                }
                return step;
            }

            // Truncation → retry with "continue smaller".
            if step.stop == StopReason::MaxTokens && retries < max_retries {
                retries += 1;
                self.messages.push(serde_json::json!({
                    "role": "user",
                    "content": "[continuation] output was truncated, continue in smaller chunks"
                }));
                continue;
            }

            // Empty response → retry with continuation.
            if step.stop == StopReason::EndTurn
                && !step.had_tools
                && !step.had_content
                && retries < max_retries
            {
                retries += 1;
                self.messages.push(serde_json::json!({
                    "role": "user",
                    "content": "[continuation] no output produced, continue"
                }));
                continue;
            }

            // Single-message loop → inject reminder + retry once.
            if step.error.is_none() && step.had_content && !step.had_tools {
                if self.loop_detector.observe(&step.content) {
                    let _ = self.output_tx.try_send(AgentEvent::LoopDetected);
                    if retries < max_retries {
                        retries += 1;
                        self.loop_detector.reset();
                        self.messages.push(serde_json::json!({
                            "role": "user",
                            "content": "[continuation] detected a loop, try a different approach"
                        }));
                        continue;
                    }
                }
            }

            return step;
        }
    }

    async fn run_step(&mut self, context: &Context) -> StepResult {
        let mut stream = self.cfg.provider.stream(&self.cfg.model, context, None);

        let mut had_tools = false;
        let mut had_content = false;
        let mut content_text = String::new();
        let mut stop = StopReason::EndTurn;
        let mut error = None;

        while let Some(item) = stream.next().await {
            match item {
                Ok(Event::Content(c)) => {
                    had_content = true;
                    if let Some(text) = c.get("text").and_then(|t| t.as_str()) {
                        content_text.push_str(text);
                    }
                    self.append_message("assistant", c.clone());
                    let _ = self
                        .output_tx
                        .send(AgentEvent::MessageUpdate {
                            agent_id: self.cfg.agent_id.clone(),
                            message: c,
                        })
                        .await;
                }
                Ok(Event::ToolCall {
                    id,
                    name,
                    arguments,
                }) => {
                    had_tools = true;
                    if name == "ask_user" {
                        self.handle_ask_user(id, arguments);
                        stop = StopReason::ToolUse;
                        break;
                    }
                    self.run_tool(id, name, arguments).await;
                    stop = StopReason::ToolUse;
                }
                Ok(Event::End { usage, stop: s }) => {
                    self.usage.input += usage.input;
                    self.usage.output += usage.output;
                    self.usage.cache_read += usage.cache_read;
                    self.usage.cache_write += usage.cache_write;
                    stop = s;
                }
                Err(e) => {
                    error = Some(e);
                    break;
                }
            }
        }

        StepResult {
            had_tools,
            had_content,
            stop,
            error,
            content: content_text,
        }
    }

    /// `ask_user` is a special case: it does not go through `run_tool`; instead
    /// the loop records a pending question and the answer re-enters on the next
    /// input.
    fn handle_ask_user(&mut self, tool_call_id: String, question: serde_json::Value) {
        self.pending_ask_user = Some(tool_call_id.clone());
        let _ = self.output_tx.try_send(AgentEvent::AskUserStarted {
            req_id: tool_call_id.clone(),
            question,
        });
        self.messages.push(serde_json::json!({
            "role": "assistant",
            "tool_calls": [{ "id": tool_call_id, "name": "ask_user" }],
        }));
    }

    async fn run_tool(&mut self, id: String, name: String, arguments: serde_json::Value) {
        let Some(tool) = self.cfg.tools.iter().find(|t| t.name() == name) else {
            self.append_tool_result(id, serde_json::json!({ "error": "unknown tool" }), true);
            return;
        };

        let call = ToolCall {
            id: id.clone(),
            name: name.clone(),
            arguments: arguments.clone(),
        };
        self.cfg.hooks.before_tool_call(&call);

        // Permission gate (fail-closed) for tools that require approval.
        if tool.requires_approval() {
            let prompt = ControlPlanePrompt {
                request_id: id.clone(),
                action: ControlPlaneAction::ExecuteTool,
                tool_call: Some(call.clone()),
                context: serde_json::json!({ "tool": name }),
            };
            if !matches!(
                self.cfg.hooks.on_control_plane_prompt(&prompt).await,
                ControlPlaneDecision::Allow
            ) {
                let result = ToolResult {
                    id: id.clone(),
                    value: serde_json::json!({ "error": "permission denied" }),
                    is_error: true,
                };
                self.cfg.hooks.after_tool_call(&call, &result);
                self.append_tool_result(id, result.value, result.is_error);
                return;
            }
        }

        let _ = self
            .output_tx
            .send(AgentEvent::ToolExecutionStart {
                id: id.clone(),
                name: name.clone(),
                args: arguments.clone(),
            })
            .await;

        let result = tool.execute(arguments, self.cancel.clone()).await;

        match result {
            Ok(value) => {
                let tr = ToolResult {
                    id: id.clone(),
                    value: value.clone(),
                    is_error: false,
                };
                self.cfg.hooks.after_tool_call(&call, &tr);
                let _ = self
                    .output_tx
                    .send(AgentEvent::ToolExecutionEnd {
                        id: id.clone(),
                        result: value.clone(),
                        is_error: false,
                    })
                    .await;
                self.append_tool_result(id, value, false);
            }
            Err(e) => {
                let tr = ToolResult {
                    id: id.clone(),
                    value: serde_json::json!({ "error": e.to_string() }),
                    is_error: true,
                };
                self.cfg.hooks.after_tool_call(&call, &tr);
                let _ = self
                    .output_tx
                    .send(AgentEvent::ToolExecutionEnd {
                        id: id.clone(),
                        result: tr.value.clone(),
                        is_error: true,
                    })
                    .await;
                self.append_tool_result(id, tr.value, true);
            }
        }
    }

    fn append_message(&mut self, role: &str, content: serde_json::Value) {
        let msg = serde_json::json!({ "role": role, "content": content });
        self.messages.push(msg);
    }

    fn append_tool_result(
        &mut self,
        tool_call_id: String,
        content: serde_json::Value,
        _is_error: bool,
    ) {
        self.messages.push(serde_json::json!({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": content,
        }));
    }
}

/// Outcome of a single provider step.
#[derive(Clone, Debug)]
struct StepResult {
    had_tools: bool,
    had_content: bool,
    stop: StopReason,
    error: Option<ProviderError>,
    content: String,
}
