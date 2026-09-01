//! Integration tests for the `eta-core` engine: a single agent running a turn,
//! executing tools, and applying the retry paths — driven by scripted mock
//! providers and an in-memory session store.

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

// ── Test doubles ─────────────────────────────────────────────────────────────

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

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    })
}

async fn collect(agent: &mut Agent, input: AgentInput) -> Vec<AgentEvent> {
    agent.send(input).await.unwrap();
    let mut events = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_millis(200), agent.recv()).await {
            Ok(Some(AgentEvent::AgentEnd)) => break,
            Ok(Some(ev)) => events.push(ev),
            Ok(None) | Err(_) => break,
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

// ── Tests ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn runs_a_basic_turn() {
    let provider = Arc::new(ScriptedProvider::new(vec![vec![
        content("hello"),
        end(StopReason::EndTurn),
    ]]));
    let mut agent = make_agent(provider, vec![]);
    let events = collect(&mut agent, user_message("hi")).await;

    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::TurnStart { .. }))
    );
    assert!(has_text(&events, "hello"));
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::TurnEnd { .. }))
    );
}

#[tokio::test]
async fn executes_a_tool_then_continues() {
    let calls = Arc::new(AtomicUsize::new(0));
    let tool: Arc<dyn Tool> = Arc::new(CountingTool {
        calls: calls.clone(),
    });

    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![
            tool_call("c1", "count", serde_json::json!({})),
            end(StopReason::ToolUse),
        ],
        vec![content("done"), end(StopReason::EndTurn)],
    ]));

    let mut agent = make_agent(provider, vec![tool]);
    let events = collect(&mut agent, user_message("go")).await;

    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolExecutionStart { name, .. } if name == "count"))
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(has_text(&events, "done"));
}

#[tokio::test]
async fn retries_on_midstream_error() {
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![Err(ProviderError::RateLimit)],
        vec![content("recovered"), end(StopReason::EndTurn)],
    ]));
    let mut agent = make_agent(provider, vec![]);
    let events = collect(&mut agent, user_message("hi")).await;

    assert!(has_text(&events, "recovered"));
}

#[tokio::test]
async fn retries_on_truncation() {
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![end(StopReason::MaxTokens)],
        vec![content("continued"), end(StopReason::EndTurn)],
    ]));
    let mut agent = make_agent(provider, vec![]);
    let events = collect(&mut agent, user_message("hi")).await;

    assert!(has_text(&events, "continued"));
}

#[tokio::test]
async fn retries_on_empty_response() {
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![end(StopReason::EndTurn)],
        vec![content("finally"), end(StopReason::EndTurn)],
    ]));
    let mut agent = make_agent(provider, vec![]);
    let events = collect(&mut agent, user_message("hi")).await;

    assert!(has_text(&events, "finally"));
}

#[tokio::test]
async fn builtin_state_tool_writes_to_store() {
    // The model calls update_state, then (next turn) continues.
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![
            tool_call(
                "s1",
                "update_state",
                serde_json::json!({ "action": "set", "key": "k", "value": "v" }),
            ),
            end(StopReason::ToolUse),
        ],
        vec![content("ok"), end(StopReason::EndTurn)],
    ]));

    let store = Arc::new(MemStore::default());
    let mut agent = Agent::spawn(AgentConfig {
        agent_id: AgentId("test".into()),
        provider,
        model: Model::new("test-model"),
        tools: vec![],
        hooks: hooks(),
        store: store.clone(),
        system_prompt: "test".into(),
        max_retries: 2,
    });
    let _events = collect(&mut agent, user_message("write k")).await;

    assert_eq!(store.get_state("k").await, Some(serde_json::json!("v")));
}

#[tokio::test]
async fn rejects_invalid_tool_arguments() {
    // update_state requires "action" and "key"; empty args are invalid.
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![
            tool_call("bad", "update_state", serde_json::json!({})),
            end(StopReason::ToolUse),
        ],
        vec![content("after"), end(StopReason::EndTurn)],
    ]));
    let mut agent = make_agent(provider, vec![]);
    let events = collect(&mut agent, user_message("go")).await;

    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolExecutionEnd { is_error: true, .. }))
    );
}
