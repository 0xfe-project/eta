//! Integration tests for the `eta-core` engine.
//!
//! Each submodule covers one behavior; shared test doubles and helpers live here.

mod ask_user;
mod basic_turn;
mod compaction;
mod goal;
mod loop_detect;
mod loop_manager;
mod mid_loop;
mod parse_duration;
mod retry;
mod state_tool;
mod todo;
mod tool_execution;
mod validation;

use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use eta_core::{
    Agent, AgentConfig, AgentEvent, AgentHooks, AgentId, AgentInput, CancelToken, Hooks,
    SessionEntry, SessionStorage, Tool, ToolError,
};
use eta_llm::{Context, Event, Model, Provider, ProviderError, StopReason, Usage};
use tokio_stream::Stream;

// ── Shared test doubles ──────────────────────────────────────────────────────

struct NoopHooks;
impl AgentHooks for NoopHooks {}

fn hooks() -> Hooks {
    let mut h = Hooks::new();
    h.push(Arc::new(NoopHooks));
    h
}

/// In-memory `SessionStorage` used to observe state writes.
#[derive(Default)]
struct MemStore {
    kv: std::sync::Mutex<serde_json::Map<String, serde_json::Value>>,
}

#[async_trait]
impl SessionStorage for MemStore {
    async fn load(&self) -> Vec<SessionEntry> {
        vec![]
    }
    async fn append(&self, _entry: SessionEntry) {}
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

/// A provider that replays a scripted sequence of streams, one per attempt.
struct ScriptedProvider {
    attempts: Vec<Vec<Result<Event, ProviderError>>>,
    count: AtomicUsize,
}

impl ScriptedProvider {
    fn new(attempts: Vec<Vec<Result<Event, ProviderError>>>) -> Self {
        Self {
            attempts,
            count: AtomicUsize::new(0),
        }
    }
}

impl Provider for ScriptedProvider {
    fn stream(
        &self,
        _model: &Model,
        _ctx: &Context,
        _opts: Option<&serde_json::Value>,
    ) -> Pin<Box<dyn Stream<Item = Result<Event, ProviderError>> + Send>> {
        let i = self
            .count
            .fetch_add(1, Ordering::SeqCst)
            .min(self.attempts.len() - 1);
        Box::pin(tokio_stream::iter(self.attempts[i].clone()))
    }
}

/// A tool that just counts its invocations.
struct CountingTool {
    calls: Arc<AtomicUsize>,
}

#[async_trait]
impl Tool for CountingTool {
    fn name(&self) -> &str {
        "count"
    }
    fn description(&self) -> &str {
        "increment a counter"
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({ "type": "object" })
    }
    async fn execute(
        &self,
        _input: serde_json::Value,
        _cancel: CancelToken,
    ) -> Result<serde_json::Value, ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(serde_json::json!({ "counted": true }))
    }
}

// ── Shared helpers ───────────────────────────────────────────────────────────

fn content(text: &str) -> Result<Event, ProviderError> {
    Ok(Event::Content(
        serde_json::json!({ "type": "text", "text": text }),
    ))
}

fn end(stop: StopReason) -> Result<Event, ProviderError> {
    Ok(Event::End {
        usage: Usage::default(),
        stop,
    })
}

fn tool_call(id: &str, name: &str, args: serde_json::Value) -> Result<Event, ProviderError> {
    Ok(Event::ToolCall {
        id: id.into(),
        name: name.into(),
        arguments: args,
    })
}

fn make_agent(provider: Arc<dyn Provider>, tools: Vec<Arc<dyn Tool>>) -> Agent {
    let store = Arc::new(MemStore::default());
    Agent::spawn(AgentConfig {
        agent_id: AgentId("test".into()),
        provider,
        model: Model::new("test-model"),
        tools,
        hooks: hooks(),
        store,
        system_prompt: "test".into(),
        max_retries: 2,
        max_goal_rounds: None,
    })
}

async fn collect(agent: &Agent, input: AgentInput) -> Vec<AgentEvent> {
    let mut rx = agent.subscribe();
    agent.send(input).await.unwrap();
    let mut events = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            Ok(Ok(AgentEvent::AgentEnd)) => break,
            Ok(Ok(ev)) => events.push(ev),
            Ok(Err(_)) | Err(_) => break,
        }
    }
    events
}

fn has_text(events: &[AgentEvent], needle: &str) -> bool {
    events.iter().any(|e| {
        matches!(e, AgentEvent::MessageUpdate { message, .. }
            if message.get("text").and_then(|t| t.as_str()) == Some(needle))
    })
}

fn user_message(text: &str) -> AgentInput {
    AgentInput::UserMessage {
        content: serde_json::json!({ "type": "text", "text": text }),
    }
}
