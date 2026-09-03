//! The agent engine: channels, the drive loop, and the retry / tool pipeline.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use tokio::sync::{broadcast, mpsc};
use tokio_stream::StreamExt;

use eta_llm::{Context, Event, Model, Provider, ProviderError, StopReason, ToolSchema, Usage};
use eta_system_prompts as prompts;

use crate::compaction;
use crate::dev_event::{AgentDevEvent, dev_category};
use crate::error::classify_provider_error;
use crate::hooks::Hooks;
use crate::loop_detect::LoopDetector;
use crate::store::{MemoryStore, SessionStorage, SkillStore};
use crate::tool::{
    CancelToken, Tool, builtin_multi_tool_use_tool, builtin_state_tools, builtin_todo_tool,
    load_todos, render_memory, render_skills, render_todos, validate_args,
};
use crate::types::{
    AgentEvent, AgentId, AgentInput, AskUserAnswer, GoalContinuationGate, GoalState, GoalStatus,
    ToolCall, ToolResult, TurnContext, TurnDriver,
};

/// Detects anti-spin: 3 consecutive tool-free turns auto-pauses the goal.
const ANTI_SPIN_LIMIT: u32 = 3;

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
    /// Skill source; its whole list is dumped into the `<skills>` block.
    /// `None` = no skills.
    pub skill_store: Option<Arc<dyn SkillStore>>,
    /// Memory source; the engine writes/reads memory here out-of-band.
    /// Required — every agent carries memory.
    pub memory_store: Arc<dyn MemoryStore>,
    pub system_prompt: String,
    /// Client/adapter system prompt injected as a separate context slot. Part-E
    /// style embedders use it to expose their own tools, environment, and
    /// host-specific conventions without editing the engine's stable block.
    pub adapter_system_prompt: String,
    pub max_retries: usize,
}

/// A handle to a running agent.
pub struct Agent {
    input: mpsc::Sender<AgentInput>,
    output: broadcast::Sender<AgentEvent>,
    dev: broadcast::Sender<AgentDevEvent>,
    answer: mpsc::Sender<AskUserAnswer>,
    usage: Arc<Mutex<Usage>>,
    cancel: CancelToken,
    memory_store: Arc<dyn MemoryStore>,
    skill_store: Option<Arc<dyn SkillStore>>,
    system_prompt: String,
    adapter_system_prompt: String,
}

impl Agent {
    /// Spawn the agent's background loop and return a handle to it.
    pub fn spawn(mut cfg: AgentConfig) -> Self {
        // Snapshot the read-only context sources before `cfg` is moved into the
        // runtime, so the handle can serve a live context view to the TUI.
        let memory_store = cfg.memory_store.clone();
        let skill_store = cfg.skill_store.clone();
        let system_prompt = cfg.system_prompt.clone();
        let adapter_system_prompt = cfg.adapter_system_prompt.clone();

        let (input_tx, input_rx) = mpsc::channel(256);
        let (output_tx, _) = broadcast::channel(256);
        let output_handle = output_tx.clone();
        let (dev_tx, _) = broadcast::channel(1024);
        let dev_handle = dev_tx.clone();
        let (answer_tx, answer_rx) = mpsc::channel(16);
        let cancel = CancelToken::new();
        let usage = Arc::new(Mutex::new(Usage::default()));

        // Builtin state + todo tools, plus user tools, form the registry;
        // multi_tool_use wraps them for parallel execution. Memory ("evo") is
        // managed out-of-band at turn end; skills are dumped wholesale, not a tool.
        let mut registry: Vec<Arc<dyn Tool>> = Vec::new();
        registry.extend(builtin_state_tools(cfg.store.clone()));
        registry.push(builtin_todo_tool(cfg.store.clone()));
        registry.append(&mut cfg.tools);

        let registry = Arc::new(registry);
        let mut tools = registry.as_ref().clone();
        tools.push(builtin_multi_tool_use_tool(registry));
        cfg.tools = tools;

        let mut runtime = AgentRuntime {
            cfg,
            messages: Vec::new(),
            mistakes: Vec::new(),
            usage: usage.clone(),
            goal: None,
            loop_detector: LoopDetector::new(),
            answer_rx,
            pending_summary: None,
            validation_failures: 0,
            compaction_epoch: 0,
            request_counter: 0,
            input_rx,
            output_tx,
            dev_tx,
            cancel: cancel.clone(),
        };

        tokio::spawn(async move {
            runtime.run().await;
        });

        Agent {
            input: input_tx,
            output: output_handle,
            dev: dev_handle,
            answer: answer_tx,
            usage,
            cancel,
            memory_store,
            skill_store,
            system_prompt,
            adapter_system_prompt,
        }
    }

    /// Send an input into the agent's queue.
    pub async fn send(&self, input: AgentInput) -> Result<(), mpsc::error::SendError<AgentInput>> {
        self.input.send(input).await
    }

    /// A clone of the agent's input channel, so an external `LoopManager` can
    /// inject `AgentInput::Loop` on the same queue the drive loop consumes.
    pub fn input_sender(&self) -> mpsc::Sender<AgentInput> {
        self.input.clone()
    }

    /// The accumulated token / cache usage so far.
    pub fn usage(&self) -> Usage {
        *self.usage.lock().unwrap()
    }

    /// Read-only memory snapshot for display. Entries are formatted as
    /// `[kind] content` without the `<memory>` wrapper.
    pub async fn memory_entries(&self) -> Vec<String> {
        self.memory_store
            .load()
            .await
            .into_iter()
            .map(|(_, entry)| {
                let kind = format!("{:?}", entry.kind).to_lowercase();
                format!("[{kind}] {}", entry.content)
            })
            .collect()
    }

    /// Read-only list of installed skill names for display.
    pub async fn skill_names(&self) -> Vec<String> {
        match &self.skill_store {
            Some(store) => store
                .list()
                .await
                .into_iter()
                .map(|skill| skill.name)
                .collect(),
            None => Vec::new(),
        }
    }

    /// The configured base system prompt (before memory/skills/todos are added).
    pub fn stable_prompt(&self) -> &str {
        &self.system_prompt
    }

    /// The adapter-provided system prompt slot, if any.
    pub fn adaptive_prompt(&self) -> &str {
        &self.adapter_system_prompt
    }

    /// Subscribe to the agent's event stream. Each call returns an independent
    /// receiver; events are broadcast to all subscribers.
    pub fn subscribe(&self) -> broadcast::Receiver<AgentEvent> {
        self.output.subscribe()
    }

    /// Subscribe to the agent's dev (observability) stream — turns, token
    /// usage, system prompt, compaction, loops, goals, and every state CRUD.
    pub fn subscribe_dev(&self) -> broadcast::Receiver<AgentDevEvent> {
        self.dev.subscribe()
    }

    /// Clone the dev-event sender for adapter-owned supervisors such as the
    /// loop manager.  Keeping this as a sender accessor avoids making the
    /// supervisor depend on the agent's private runtime implementation.
    pub fn dev_sender(&self) -> broadcast::Sender<AgentDevEvent> {
        self.dev.clone()
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
    mistakes: Vec<String>,
    usage: Arc<Mutex<Usage>>,
    goal: Option<GoalState>,
    loop_detector: LoopDetector,
    answer_rx: mpsc::Receiver<AskUserAnswer>,
    pending_summary: Option<tokio::task::JoinHandle<String>>,
    validation_failures: u32,
    compaction_epoch: u64,
    request_counter: u64,
    input_rx: mpsc::Receiver<AgentInput>,
    output_tx: broadcast::Sender<AgentEvent>,
    dev_tx: broadcast::Sender<AgentDevEvent>,
    cancel: CancelToken,
}

#[derive(Clone, Copy, Debug)]
struct TurnOutcome {
    had_tools: bool,
}

impl AgentRuntime {
    /// Emit a dev (observability) event. Fire-and-forget; a full/closed channel
    /// never blocks the engine.
    fn emit_dev(&self, category: &str, action: &str, data: serde_json::Value) {
        let _ = self.dev_tx.send(AgentDevEvent::new(
            self.cfg.agent_id.clone(),
            category,
            action,
            data,
        ));
    }
}

impl AgentRuntime {
    async fn run(&mut self) {
        let agent_id = self.cfg.agent_id.clone();
        self.restore_messages().await;
        self.cfg.hooks.on_spawn(&agent_id);
        self.emit_dev(dev_category::LIFECYCLE, "spawn", serde_json::json!({}));

        while !self.cancel.is_cancelled() {
            let Some(input) = self.input_rx.recv().await else {
                break;
            };
            self.cfg.hooks.on_queue_in(&input);

            match input {
                AgentInput::UserMessage { content } => {
                    self.append_message("user", content).await;
                    self.run_turn_chain().await;
                }
                AgentInput::Steer { message } => {
                    self.cfg.hooks.on_steer(&TurnContext {
                        agent_id: agent_id.clone(),
                        request_id: String::new(),
                        messages_since_start: self.messages.len(),
                    });
                    self.append_message("user", message).await;
                    self.run_turn_chain().await;
                }
                AgentInput::Loop { loop_id, prompt } => {
                    self.emit_dev(
                        dev_category::LOOP,
                        "fired",
                        serde_json::json!({ "loop_id": loop_id }),
                    );
                    self.append_message("user", prompt).await;
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
                AgentInput::Compact => {
                    self.compact(true).await;
                }
                AgentInput::Abort { reason } => {
                    self.emit_dev(
                        dev_category::LIFECYCLE,
                        "abort",
                        serde_json::json!({ "reason": reason }),
                    );
                    break;
                }
                AgentInput::Resume | AgentInput::Custom(_) => {}
            }
        }

        self.cfg.hooks.on_stop(&agent_id);
        self.emit_dev(dev_category::LIFECYCLE, "stop", serde_json::json!({}));
        let _ = self.output_tx.send(AgentEvent::AgentEnd);
    }

    fn emit_goal_change(&self) {
        if let Some(g) = &self.goal {
            let _ = self
                .output_tx
                .send(AgentEvent::GoalStateChange { status: g.status });
            self.emit_dev(
                dev_category::GOAL,
                "change",
                serde_json::json!({
                    "objective": g.objective,
                    "status": format!("{:?}", g.status),
                    "round_count": g.round_count,
                    "idle_without_tools": g.idle_without_tools,
                }),
            );
            self.cfg.hooks.on_goal_change(g);
        }
    }

    /// Run turns until no driver is pending. Dequeue-once per turn boundary:
    /// one `pop_front`, at most one `push_back`. At natural chain end, extract
    /// memory out-of-band so the agent stays unaware of it.
    async fn run_turn_chain(&mut self) {
        let turn_start = self.messages.len();
        let mut queue: VecDeque<TurnDriver> = VecDeque::new();
        queue.push_back(TurnDriver::UserMessage(serde_json::Value::Null));

        let todos = load_todos(self.cfg.store.as_ref()).await;
        let todo_sentinel_idx = self.messages.len();
        let injected_todo_sentinel = !todos.is_empty();
        if injected_todo_sentinel {
            self.messages.push(serde_json::json!({
                "role": "user",
                "content": prompts::TODO_REVIEW_PROMPT,
            }));
            self.emit_dev(
                dev_category::TODO,
                "review_injected",
                serde_json::json!({ "count": todos.len() }),
            );
        }

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
                if self.evaluate_goal_achieved().await {
                    if let Some(g) = &mut self.goal {
                        g.status = GoalStatus::Achieved;
                    }
                    self.emit_goal_change();
                    break;
                }
                queue.push_back(TurnDriver::GoalContinuation);
            }
            // else: no next driver → natural chain end → extract memory below.
        }

        self.extract_memory(self.messages[turn_start..].to_vec())
            .await;

        if injected_todo_sentinel && todo_sentinel_idx < self.messages.len() {
            self.messages.remove(todo_sentinel_idx);
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

    /// Natural chain end: extract memory out-of-band (the agent's only memory
    /// writer). Input is just this turn's new messages, not the whole transcript.
    async fn extract_memory(&mut self, turn_messages: Vec<serde_json::Value>) {
        if turn_messages.is_empty() {
            return;
        }
        let mut prompt_messages = turn_messages;
        prompt_messages.push(serde_json::json!({
            "role": "user",
            "content": prompts::MEMORY_EXTRACT_PROMPT,
        }));
        let context = Context {
            system_prompt: Some(prompts::MEMORY_EXTRACT_SYSTEM_PROMPT.to_string()),
            adapter_system_prompt: None,
            messages: prompt_messages,
            tools: vec![],
        };
        let mut stream = self.cfg.provider.stream(&self.cfg.model, &context, None);
        let mut out = String::new();
        while let Some(item) = stream.next().await {
            if let Ok(Event::Content(c)) = item {
                if let Some(t) = c.get("text").and_then(|t| t.as_str()) {
                    out.push_str(t);
                }
            }
        }
        let edits: serde_json::Value =
            serde_json::from_str(&out).unwrap_or_else(|_| serde_json::json!({}));
        if edits.as_object().map(|o| o.is_empty()).unwrap_or(true) {
            return;
        }
        self.emit_dev(dev_category::MEMORY, "edit", edits.clone());
        let _ = self.cfg.memory_store.apply(&edits).await;
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
            adapter_system_prompt: None,
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

    /// Authoritative compaction: fold the prefix into a
    /// `[Previous conversation summary]`, drop tool noise, and bump the epoch.
    ///
    /// Called at turn boundaries with `force = false` (only above the window
    /// threshold); `/compact` calls it with `force = true` to compress now.
    async fn compact(&mut self, force: bool) {
        let Some(window) = self.cfg.model.context_window else {
            return;
        };
        let window = window as usize;
        if !force && !compaction::should_compact(&self.messages, window) {
            return;
        }
        let keep_recent = (window / 4).max(1);
        let (mut prefix, mut suffix) = compaction::partition(&self.messages, keep_recent);
        if prefix.is_empty() {
            // Forced `/compact` on a small context still compresses: summarize
            // everything but the newest message.
            if force && self.messages.len() > 1 {
                let split = self.messages.len() - 1;
                prefix = self.messages[..split].to_vec();
                suffix = self.messages[split..].to_vec();
            } else {
                return;
            }
        }
        let tokens_before = compaction::estimate_tokens(&self.messages);
        let prefix = compaction::drop_tool_pairs(&prefix);
        let summary = summarize_with(
            self.cfg.provider.clone(),
            self.cfg.model.clone(),
            prefix.clone(),
        )
        .await;

        // Deterministic fallback when the LLM summarizer fails: max-min-fair
        // truncation, marked untrusted/informational.
        let content = if summary.trim().is_empty() {
            match compaction::truncate_fairly(&prefix, keep_recent * 4) {
                Some(truncated) => format!("{}\n{}", prompts::UNTRUSTED_SUMMARY_NOTE, truncated),
                None => prompts::UNTRUSTED_SUMMARY_NOTE.to_string(),
            }
        } else {
            summary
        };

        let mut new_messages = vec![serde_json::json!({
            "role": "user",
            "content": prompts::previous_summary(&content),
        })];
        new_messages.extend(suffix);
        self.messages = new_messages;
        self.compaction_epoch += 1;
        let tokens_after = compaction::estimate_tokens(&self.messages);
        self.emit_dev(
            dev_category::COMPACTION,
            "complete",
            serde_json::json!({
                "tokens_before": tokens_before,
                "tokens_after": tokens_after,
                "epoch": self.compaction_epoch,
            }),
        );
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
    /// then let hooks transform it. Reads the todo list from session state.
    async fn build_context(&self) -> Context {
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
        let mut system_prompt = String::new();
        system_prompt.push_str(prompts::DEFAULT_SYSTEM_PROMPT);
        if !self.cfg.system_prompt.is_empty() {
            system_prompt.push_str("\n\n");
            system_prompt.push_str(&self.cfg.system_prompt);
        }

        // Goal guidelines when a goal is active (goal-mode prompt enhancement).
        if let Some(goal) = &self.goal {
            system_prompt.push_str("\n\n");
            system_prompt.push_str(&goal.build_goal_pursuit_guidelines());
        }

        // Current-tasks (todo) durable block.
        let todos = load_todos(self.cfg.store.as_ref()).await;
        let todos_block = render_todos(&todos);
        if !todos_block.is_empty() {
            system_prompt.push_str("\n\n");
            system_prompt.push_str(&todos_block);
        }

        // Memory: render only (read-only), no guidance on how it's written.
        let memory = self.cfg.memory_store.load().await;
        let memory_block = render_memory(&memory);
        if !memory_block.is_empty() {
            system_prompt.push_str("\n\n");
            system_prompt.push_str(&memory_block);
        }

        // Skills: dump the whole installed list (name + path/body).
        if let Some(skill_store) = &self.cfg.skill_store {
            let skills = skill_store.list().await;
            let skills_block = render_skills(&skills);
            if !skills_block.is_empty() {
                system_prompt.push_str("\n\n");
                system_prompt.push_str(&skills_block);
            }
        }

        let mut context = Context {
            system_prompt: Some(system_prompt.clone()),
            adapter_system_prompt: (!self.cfg.adapter_system_prompt.is_empty())
                .then(|| self.cfg.adapter_system_prompt.clone()),
            messages: normalize_messages(&self.messages),
            tools: tool_schemas,
        };
        self.cfg.hooks.transform_context(&mut context);
        self.emit_dev(
            dev_category::PROMPT,
            "assembled",
            serde_json::json!({
                "system_prompt": system_prompt,
                "tool_count": self.cfg.tools.len(),
            }),
        );
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
        self.emit_dev(
            dev_category::TURN,
            "start",
            serde_json::json!({ "request_id": request_id }),
        );

        // Turn-boundary compaction (authoritative, between turns).
        self.compact(false).await;

        let step = self.run_step_with_retry().await;

        self.cfg.hooks.on_turn_end(&turn_ctx);
        let _ = self.output_tx.send(AgentEvent::TurnEnd {
            request_id: request_id.clone(),
        });
        self.emit_dev(
            dev_category::TURN,
            "end",
            serde_json::json!({ "request_id": request_id }),
        );

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
                    self.emit_dev(
                        dev_category::RETRY,
                        "error",
                        serde_json::json!({ "attempt": retries, "error": err.to_string() }),
                    );
                    self.messages
                        .push(serde_json::json!({ "role": "user", "content": prompts::RESUME }));
                    continue;
                }
                // Final (non-retriable or exhausted) error: surface it so the
                // dev panel can show exactly why the turn produced no text.
                self.emit_dev(
                    dev_category::RETRY,
                    "error",
                    serde_json::json!({ "error": err.to_string() }),
                );
                return step;
            }

            // Truncation → retry with "continue smaller".
            if step.stop == StopReason::MaxTokens && retries < max_retries {
                retries += 1;
                self.emit_dev(
                    dev_category::RETRY,
                    "max_tokens",
                    serde_json::json!({ "attempt": retries }),
                );
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
                self.emit_dev(
                    dev_category::RETRY,
                    "empty",
                    serde_json::json!({ "attempt": retries }),
                );
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
        let context = self.build_context().await;
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
                    self.append_message("assistant", c.clone()).await;
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
                    let mut acc = self.usage.lock().unwrap();
                    acc.input += usage.input;
                    acc.output += usage.output;
                    acc.cache_read += usage.cache_read;
                    acc.cache_write += usage.cache_write;
                    drop(acc);
                    self.emit_dev(
                        dev_category::USAGE,
                        "delta",
                        serde_json::json!({
                            "input": usage.input,
                            "output": usage.output,
                            "cache_read": usage.cache_read,
                            "cache_write": usage.cache_write,
                        }),
                    );
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
            question: question.clone(),
        });
        self.emit_dev(
            dev_category::ASK_USER,
            "asked",
            serde_json::json!({ "req_id": tool_call_id, "question": question }),
        );
        let tool_use = serde_json::json!({
            "role": "assistant",
            "tool_calls": [{ "id": tool_call_id, "name": "ask_user" }],
        });
        self.messages.push(tool_use.clone());
        self.persist_message(&tool_use).await;

        while let Some(answer) = self.answer_rx.recv().await {
            if answer.tool_call_id == tool_call_id {
                self.emit_dev(
                    dev_category::ASK_USER,
                    "answered",
                    serde_json::json!({ "req_id": tool_call_id }),
                );
                let tool_result = serde_json::json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": answer.answer,
                });
                self.messages.push(tool_result.clone());
                self.persist_message(&tool_result).await;
                return;
            }
            // Ignore answers for a different (stale) question.
        }
    }

    async fn run_tool(&mut self, id: String, name: String, arguments: serde_json::Value) {
        let Some(tool) = self.cfg.tools.iter().find(|t| t.name() == name) else {
            self.append_tool_result(id, serde_json::json!({ "error": "unknown tool" }), true)
                .await;
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
            self.append_tool_result(id, result.value, true).await;
            return;
        }
        self.validation_failures = 0;

        let _ = self.output_tx.send(AgentEvent::ToolExecutionStart {
            id: id.clone(),
            name: name.clone(),
            args: arguments.clone(),
        });
        self.emit_dev(
            dev_category::TOOL,
            "start",
            serde_json::json!({ "id": id.clone(), "name": name.clone(), "args": arguments.clone() }),
        );

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
                self.emit_dev(
                    dev_category::TOOL,
                    "end",
                    serde_json::json!({ "id": id.clone(), "name": name.clone(), "is_error": false }),
                );
                self.emit_crud(&name, &call.arguments);
                self.append_tool_result(id, value, false).await;
            }
            Err(e) => {
                self.mistakes
                    .push(format!("tool {} failed: {e}", call.name));
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
                self.emit_dev(
                    dev_category::TOOL,
                    "end",
                    serde_json::json!({ "id": id, "name": name, "is_error": true, "error": e.to_string() }),
                );
                self.append_tool_result(id, tr.value, true).await;
            }
        }
    }

    async fn append_message(&mut self, role: &str, content: serde_json::Value) {
        let msg = serde_json::json!({ "role": role, "content": content });
        self.messages.push(msg.clone());
        self.persist_message(&msg).await;
    }

    /// Emit a semantic CRUD dev event for the builtin state / todo tools
    /// (they write straight to the store, bypassing the message pipeline).
    fn emit_crud(&self, name: &str, args: &serde_json::Value) {
        match name {
            "update_state" => self.emit_dev(
                dev_category::STATE,
                args.get("action").and_then(|a| a.as_str()).unwrap_or("set"),
                serde_json::json!({ "key": args.get("key") }),
            ),
            "update_todos" => self.emit_dev(dev_category::TODO, "update", args.clone()),
            _ => {}
        }
    }

    async fn append_tool_result(
        &mut self,
        tool_call_id: String,
        content: serde_json::Value,
        _is_error: bool,
    ) {
        let msg = serde_json::json!({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": content,
        });
        self.messages.push(msg.clone());
        self.persist_message(&msg).await;
    }

    async fn persist_message(&self, message: &serde_json::Value) {
        let kind = match message.get("role").and_then(|v| v.as_str()) {
            Some("user") => crate::store::entry_kind::USER_MESSAGE,
            Some("assistant") => crate::store::entry_kind::ASSISTANT_MESSAGE,
            Some("tool") => crate::store::entry_kind::TOOL_RESULT,
            _ => return,
        };
        self.cfg
            .store
            .append(crate::store::SessionEntry {
                id: 0,
                kind: kind.into(),
                data: message.clone(),
            })
            .await;
    }

    async fn restore_messages(&mut self) {
        let entries = self.cfg.store.load().await;
        self.messages = entries
            .into_iter()
            .filter(|entry| {
                matches!(
                    entry.kind.as_str(),
                    crate::store::entry_kind::USER_MESSAGE
                        | crate::store::entry_kind::ASSISTANT_MESSAGE
                        | crate::store::entry_kind::TOOL_RESULT
                )
            })
            .map(|entry| entry.data)
            .collect();
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
///
/// Anti-overflow: retries up to 3 times, asking for shorter output on empty /
/// truncated results.
async fn summarize_with(
    provider: Arc<dyn Provider>,
    model: Model,
    messages: Vec<serde_json::Value>,
) -> String {
    const MAX_ATTEMPTS: usize = 3;
    let mut shorter = false;
    for _ in 0..MAX_ATTEMPTS {
        let mut request = prompts::SUMMARIZE_REQUEST.to_string();
        if shorter {
            request.push_str("\n\n");
            request.push_str(prompts::SUMMARIZE_SHORTER_RETRY);
        }
        let mut prompt_messages = messages.clone();
        prompt_messages.push(serde_json::json!({ "role": "user", "content": request }));
        let context = Context {
            system_prompt: Some(prompts::SUMMARIZE_SYSTEM_PROMPT.to_string()),
            adapter_system_prompt: None,
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
        if !out.trim().is_empty() {
            return out;
        }
        shorter = true;
    }
    String::new()
}

/// Normalize a transcript for the provider. Streaming code may have appended
/// one assistant message per content delta, and persisted/reconstructed
/// histories can contain invalid same-role runs. Coalesce consecutive
/// assistant text messages, then insert lightweight sentinels so the role
/// sequence stays valid: user/user → assistant " ", assistant/assistant →
/// user " ", and a tool-call assistant between assistants gets `{}` as a
/// tool result instead of a plain space.
fn normalize_messages(messages: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut merged: Vec<serde_json::Value> = Vec::new();

    for message in messages {
        let role = message
            .get("role")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if role == "assistant" && message.get("tool_calls").is_none() {
            let text = message
                .get("content")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            if let Some(last) = merged.last_mut()
                && last.get("role").and_then(serde_json::Value::as_str) == Some("assistant")
                && last.get("tool_calls").is_none()
            {
                let previous = last
                    .get("content")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                *last = serde_json::json!({
                    "role": "assistant",
                    "content": format!("{previous}{text}"),
                });
                continue;
            }
        }
        merged.push(message.clone());
    }

    #[derive(PartialEq)]
    enum ChatRole {
        User,
        Assistant,
    }

    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut last_chat: Option<ChatRole> = None;
    for message in merged {
        let role = message
            .get("role")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        match role {
            "user" => {
                if last_chat == Some(ChatRole::User) {
                    out.push(serde_json::json!({ "role": "assistant", "content": " " }));
                }
                out.push(message);
                last_chat = Some(ChatRole::User);
            }
            "assistant" => {
                let is_tool_call = message.get("tool_calls").is_some();
                if last_chat == Some(ChatRole::Assistant) {
                    if is_tool_call {
                        out.push(serde_json::json!({
                            "role": "tool",
                            "tool_call_id": "",
                            "content": serde_json::json!({}),
                        }));
                    } else {
                        out.push(serde_json::json!({ "role": "user", "content": " " }));
                    }
                }
                out.push(message);
                last_chat = Some(ChatRole::Assistant);
            }
            "tool" => {
                out.push(message);
            }
            _ => {
                out.push(message);
            }
        }
    }
    out
}
