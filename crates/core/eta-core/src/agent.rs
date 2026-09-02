//! The agent engine: channels, the drive loop, and the retry / tool pipeline.

use std::collections::VecDeque;
use std::sync::Arc;

use tokio::sync::{broadcast, mpsc};
use tokio_stream::StreamExt;

use eta_llm::{Context, Event, Model, Provider, ProviderError, StopReason, ToolSchema, Usage};
use eta_system_prompts as prompts;

use crate::compaction;
use crate::error::classify_provider_error;
use crate::hooks::Hooks;
use crate::loop_detect::LoopDetector;
use crate::store::SessionStorage;
use crate::tool::{CancelToken, Tool, builtin_state_tools, validate_args};
use crate::types::{
    AgentEvent, AgentId, AgentInput, AskUserAnswer, ControlPlaneAction, ControlPlaneDecision,
    ControlPlanePrompt, GoalContinuationGate, GoalState, GoalStatus, ToolCall, ToolResult,
    TurnContext, TurnDriver,
};

/// Detects anti-spin: 3 consecutive tool-free turns auto-pauses the goal.
const ANTI_SPIN_LIMIT: u32 = 3;

/// Default goal round cap when the config does not specify one.
const DEFAULT_MAX_GOAL_ROUNDS: u32 = 100;

/// Mid-loop summarization thresholds (percentage of the context window).
const MID_LOOP_APPROACH_PCT: usize = 80;
const MID_LOOP_SEVERE_PCT: usize = 95;

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
    /// Goal self-continuation cap (`None` = `DEFAULT_MAX_GOAL_ROUNDS`).
    pub max_goal_rounds: Option<u32>,
}

/// A handle to a running agent.
pub struct Agent {
    input: mpsc::Sender<AgentInput>,
    output: broadcast::Sender<AgentEvent>,
    answer: mpsc::Sender<AskUserAnswer>,
    cancel: CancelToken,
}

impl Agent {
    /// Spawn the agent's background loop and return a handle to it.
    pub fn spawn(mut cfg: AgentConfig) -> Self {
        let (input_tx, input_rx) = mpsc::channel(256);
        let (output_tx, _) = broadcast::channel(256);
        let output_handle = output_tx.clone();
        let (answer_tx, answer_rx) = mpsc::channel(16);
        let cancel = CancelToken::new();

        // Builtin state tools always attach to the session store.
        cfg.tools.extend(builtin_state_tools(cfg.store.clone()));

        let mut runtime = AgentRuntime {
            cfg,
            messages: Vec::new(),
            usage: Usage::default(),
            goal: None,
            loop_detector: LoopDetector::new(),
            answer_rx,
            pending_summary: None,
            validation_failures: 0,
            compaction_epoch: 0,
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
            output: output_handle,
            answer: answer_tx,
            cancel,
        }
    }

    /// Send an input into the agent's queue.
    pub async fn send(&self, input: AgentInput) -> Result<(), mpsc::error::SendError<AgentInput>> {
        self.input.send(input).await
    }

    /// Subscribe to the agent's event stream. Each call returns an independent
    /// receiver; events are broadcast to all subscribers.
    pub fn subscribe(&self) -> broadcast::Receiver<AgentEvent> {
        self.output.subscribe()
    }

    /// Answer a pending `ask_user` question.
    pub async fn answer(
        &self,
        answer: AskUserAnswer,
    ) -> Result<(), mpsc::error::SendError<AskUserAnswer>> {
        self.answer.send(answer).await
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
    answer_rx: mpsc::Receiver<AskUserAnswer>,
    pending_summary: Option<tokio::task::JoinHandle<String>>,
    validation_failures: u32,
    compaction_epoch: u64,
    request_counter: u64,
    input_rx: mpsc::Receiver<AgentInput>,
    output_tx: broadcast::Sender<AgentEvent>,
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
                AgentInput::Abort { reason } => {
                    let _ = reason;
                    break;
                }
                AgentInput::Resume | AgentInput::Custom(_) => {}
            }
        }

        self.cfg.hooks.on_stop(&agent_id);
        let _ = self.output_tx.send(AgentEvent::AgentEnd);
    }

    fn emit_goal_change(&self) {
        if let Some(g) = &self.goal {
            let _ = self
                .output_tx
                .send(AgentEvent::GoalStateChange { status: g.status });
            self.cfg.hooks.on_goal_change(g);
        }
    }

    /// Run turns until no driver is pending. Dequeue-once per turn boundary:
    /// one `pop_front`, at most one `push_back`.
    async fn run_turn_chain(&mut self) {
        let mut queue: VecDeque<TurnDriver> = VecDeque::new();
        queue.push_back(TurnDriver::UserMessage(serde_json::Value::Null));

        while let Some(_driver) = queue.pop_front() {
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

            // Enqueue the next driver.
            if outcome.had_tools {
                queue.push_back(TurnDriver::UserMessage(serde_json::Value::Null));
                continue;
            }
            if self.should_continue_goal() {
                if let Some(g) = &mut self.goal {
                    g.round_count += 1;
                }
                let max_rounds = self.cfg.max_goal_rounds.unwrap_or(DEFAULT_MAX_GOAL_ROUNDS);
                let over_limit = self
                    .goal
                    .as_ref()
                    .is_some_and(|g| g.round_count >= max_rounds);
                if over_limit || self.evaluate_goal_achieved().await {
                    if let Some(g) = &mut self.goal {
                        g.status = GoalStatus::Achieved;
                    }
                    self.emit_goal_change();
                    break;
                }
                queue.push_back(TurnDriver::GoalContinuation);
            }
            // else: no next driver → loop ends.
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

    /// Run an independent, tool-free evaluation call to judge whether the active
    /// goal is achieved. Returns true when the model answers affirmatively.
    async fn evaluate_goal_achieved(&mut self) -> bool {
        let Some(goal) = self.goal.clone() else {
            return false;
        };
        // Bounded transcript: only the tail of the conversation.
        let messages: Vec<serde_json::Value> = self
            .messages
            .iter()
            .rev()
            .take(20)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let context = Context {
            system_prompt: Some(prompts::goal_evaluator_prompt(&goal.objective)),
            messages,
            tools: vec![],
        };

        let mut stream = self.cfg.provider.stream(&self.cfg.model, &context, None);
        let mut answer = String::new();
        while let Some(item) = stream.next().await {
            if let Ok(Event::Content(c)) = item {
                if let Some(t) = c.get("text").and_then(|t| t.as_str()) {
                    answer.push_str(t);
                }
            }
        }
        answer.trim().to_ascii_uppercase().starts_with("YES")
    }

    /// Rough token estimate (~4 chars per token).
    fn estimate_tokens(&self) -> usize {
        compaction::estimate_tokens(&self.messages)
    }

    /// Turn-boundary authoritative compaction: when the context is ≥80% of the
    /// window, fold the prefix into a `[Previous conversation summary]`, drop
    /// tool noise, and bump the compaction epoch.
    async fn maybe_compact(&mut self) {
        let Some(window) = self.cfg.model.context_window else {
            return;
        };
        let window = window as usize;
        if !compaction::should_compact(&self.messages, window) {
            return;
        }
        let keep_recent = (window / 4).max(1);
        let (prefix, suffix) = compaction::partition(&self.messages, keep_recent);
        if prefix.is_empty() {
            return;
        }
        let tokens_before = compaction::estimate_tokens(&self.messages);
        let prefix = compaction::drop_tool_pairs(&prefix);
        let summary =
            summarize_with(self.cfg.provider.clone(), self.cfg.model.clone(), prefix).await;

        let mut new_messages = vec![serde_json::json!({
            "role": "user",
            "content": prompts::previous_summary(&summary),
        })];
        new_messages.extend(suffix);
        self.messages = new_messages;
        self.compaction_epoch += 1;
        let _ = self.output_tx.send(AgentEvent::Compaction {
            tokens_before: tokens_before as u64,
        });
    }

    /// Mid-loop emergency compression, two-tier:
    /// - approaching the window (`MID_LOOP_APPROACH_PCT`): start an async
    ///   background summary, don't block;
    /// - severely over (`MID_LOOP_SEVERE_PCT`): block until summarized.
    /// The result is temporary — the authoritative compaction (B11) replaces it.
    async fn maybe_summarize_mid_loop(&mut self) {
        let Some(window) = self.cfg.model.context_window else {
            return;
        };
        let window = window as usize;
        let keep = 4;
        if self.messages.len() <= keep {
            return;
        }

        // Collect a finished background summary, if any.
        if let Some(handle) = self.pending_summary.take() {
            if handle.is_finished() {
                if let Ok(summary) = handle.await {
                    self.apply_summary(summary, keep);
                    return;
                }
            } else {
                self.pending_summary = Some(handle);
            }
        }

        let pct = self.estimate_tokens() * 100 / window.max(1);
        if pct >= MID_LOOP_SEVERE_PCT {
            // Severe: block until summarized.
            let split = self.messages.len() - keep;
            let prefix = self.messages[..split].to_vec();
            let summary =
                summarize_with(self.cfg.provider.clone(), self.cfg.model.clone(), prefix).await;
            self.apply_summary(summary, keep);
        } else if pct >= MID_LOOP_APPROACH_PCT && self.pending_summary.is_none() {
            // Approach: start a background summary, don't block.
            let split = self.messages.len() - keep;
            let prefix = self.messages[..split].to_vec();
            let provider = self.cfg.provider.clone();
            let model = self.cfg.model.clone();
            self.pending_summary = Some(tokio::spawn(async move {
                summarize_with(provider, model, prefix).await
            }));
        }
    }

    /// Replace the prefix with a `[Previous conversation summary]`, keeping the
    /// most recent `keep` messages.
    fn apply_summary(&mut self, summary: String, keep: usize) {
        let split = self.messages.len() - keep;
        let mut new_messages = vec![serde_json::json!({
            "role": "user",
            "content": prompts::previous_summary(&summary),
        })];
        new_messages.extend_from_slice(&self.messages[split..]);
        self.messages = new_messages;
    }

    /// Assemble the LLM context for a step (system prompt + messages + tools),
    /// then let hooks transform it.
    fn build_context(&self) -> Context {
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
        context
    }

    async fn run_turn(&mut self) -> TurnOutcome {
        let agent_id = self.cfg.agent_id.clone();
        self.request_counter += 1;
        let request_id = format!("req_{}", self.request_counter);

        let turn_ctx = TurnContext {
            agent_id: agent_id.clone(),
            request_id: request_id.clone(),
            messages_since_start: self.messages.len(),
        };

        self.cfg.hooks.on_turn_start(&turn_ctx);
        let _ = self.output_tx.send(AgentEvent::TurnStart {
            request_id: request_id.clone(),
        });

        // Turn-boundary compaction (authoritative, between turns).
        self.maybe_compact().await;

        let step = self.run_step_with_retry().await;

        self.cfg.hooks.on_turn_end(&turn_ctx);
        let _ = self.output_tx.send(AgentEvent::TurnEnd {
            request_id: request_id.clone(),
        });

        TurnOutcome {
            had_tools: step.had_tools,
        }
    }

    /// One provider step + the three retry paths (error / truncation / empty /
    /// single-message loop).
    async fn run_step_with_retry(&mut self) -> StepResult {
        let max_retries = self.cfg.max_retries;
        let mut retries = 0usize;

        loop {
            let step = self.run_step().await;

            // Mid-stream / setup error → retry (retriable only).
            if let Some(err) = &step.error {
                if retries < max_retries && classify_provider_error(err).is_retryable() {
                    retries += 1;
                    self.messages
                        .push(serde_json::json!({ "role": "user", "content": prompts::RESUME }));
                    continue;
                }
                return step;
            }

            // Truncation → retry with "continue smaller".
            if step.stop == StopReason::MaxTokens && retries < max_retries {
                retries += 1;
                self.messages.push(serde_json::json!({
                    "role": "user",
                    "content": prompts::RESUME_TRUNCATED
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
                    "content": prompts::RESUME_EMPTY
                }));
                continue;
            }

            // Single-message loop → inject reminder + retry once.
            if step.error.is_none() && step.had_content && !step.had_tools {
                if self.loop_detector.observe(&step.content) {
                    let _ = self.output_tx.send(AgentEvent::LoopDetected);
                    if retries < max_retries {
                        retries += 1;
                        self.loop_detector.reset();
                        self.messages.push(serde_json::json!({
                            "role": "user",
                            "content": prompts::RESUME_LOOP
                        }));
                        continue;
                    }
                }
            }

            return step;
        }
    }

    async fn run_step(&mut self) -> StepResult {
        self.maybe_summarize_mid_loop().await;
        let context = self.build_context();
        let mut stream = self.cfg.provider.stream(&self.cfg.model, &context, None);

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
                    let _ = self.output_tx.send(AgentEvent::MessageUpdate {
                        agent_id: self.cfg.agent_id.clone(),
                        message: c,
                    });
                }
                Ok(Event::ToolCall {
                    id,
                    name,
                    arguments,
                }) => {
                    had_tools = true;
                    if name == "ask_user" {
                        self.handle_ask_user(id, arguments).await;
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

    /// `ask_user` is a special case: it does not go through `run_tool`. Instead
    /// the loop emits `AskUserStarted` and blocks on the dedicated answer
    /// channel until the matching answer arrives.
    async fn handle_ask_user(&mut self, tool_call_id: String, question: serde_json::Value) {
        let _ = self.output_tx.send(AgentEvent::AskUserStarted {
            req_id: tool_call_id.clone(),
            question,
        });
        self.messages.push(serde_json::json!({
            "role": "assistant",
            "tool_calls": [{ "id": tool_call_id, "name": "ask_user" }],
        }));

        while let Some(answer) = self.answer_rx.recv().await {
            if answer.tool_call_id == tool_call_id {
                self.messages.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": answer.answer,
                }));
                return;
            }
            // Ignore answers for a different (stale) question.
        }
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

        // Validate arguments against the tool's input JSON Schema; feed any
        // error back to the model so it can retry, up to 3 times, then ask the
        // user to correct the input.
        if let Err(msg) = validate_args(&tool.schema(), &arguments) {
            self.validation_failures += 1;
            if self.validation_failures >= 3 {
                self.validation_failures = 0;
                self.handle_ask_user(
                    id,
                    serde_json::json!({
                        "kind": "fill",
                        "question": format!("Tool '{name}' was called with invalid arguments: {msg}"),
                    }),
                )
                .await;
                return;
            }
            let result = ToolResult {
                id: id.clone(),
                value: serde_json::json!({ "error": msg }),
                is_error: true,
            };
            self.cfg.hooks.after_tool_call(&call, &result);
            let _ = self.output_tx.send(AgentEvent::ToolExecutionEnd {
                id: id.clone(),
                result: result.value.clone(),
                is_error: true,
            });
            self.append_tool_result(id, result.value, true);
            return;
        }
        self.validation_failures = 0;

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

        let _ = self.output_tx.send(AgentEvent::ToolExecutionStart {
            id: id.clone(),
            name: name.clone(),
            args: arguments.clone(),
        });

        let result = tool.execute(arguments, self.cancel.clone()).await;

        match result {
            Ok(value) => {
                let tr = ToolResult {
                    id: id.clone(),
                    value: value.clone(),
                    is_error: false,
                };
                self.cfg.hooks.after_tool_call(&call, &tr);
                let _ = self.output_tx.send(AgentEvent::ToolExecutionEnd {
                    id: id.clone(),
                    result: value.clone(),
                    is_error: false,
                });
                self.append_tool_result(id, value, false);
            }
            Err(e) => {
                let tr = ToolResult {
                    id: id.clone(),
                    value: serde_json::json!({ "error": e.to_string() }),
                    is_error: true,
                };
                self.cfg.hooks.after_tool_call(&call, &tr);
                let _ = self.output_tx.send(AgentEvent::ToolExecutionEnd {
                    id: id.clone(),
                    result: tr.value.clone(),
                    is_error: true,
                });
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

/// Summarize `messages` into a single concise string. Shared by mid-loop
/// summarization and (later) authoritative compaction.
async fn summarize_with(
    provider: Arc<dyn Provider>,
    model: Model,
    messages: Vec<serde_json::Value>,
) -> String {
    let mut prompt_messages = messages;
    prompt_messages.push(serde_json::json!({
        "role": "user",
        "content": prompts::SUMMARIZE_REQUEST,
    }));
    let context = Context {
        system_prompt: Some(prompts::SUMMARIZE_SYSTEM_PROMPT.to_string()),
        messages: prompt_messages,
        tools: vec![],
    };
    let mut stream = provider.stream(&model, &context, None);
    let mut out = String::new();
    while let Some(item) = stream.next().await {
        if let Ok(Event::Content(c)) = item {
            if let Some(t) = c.get("text").and_then(|t| t.as_str()) {
                out.push_str(t);
            }
        }
    }
    out
}
