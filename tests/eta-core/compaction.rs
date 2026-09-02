//! Compaction: context compression at the turn boundary.

use async_trait::async_trait;
use eta_core::{
    drop_tool_pairs, max_min_fair_allocations, partition, reduce_budget, should_compact,
    truncate_fairly,
};

use super::*;

// ── Pure functions ───────────────────────────────────────────────────────────

#[test]
fn max_min_fair_allocations_distributes_budget() {
    // Small message gets its full size; the large one gets the rest.
    assert_eq!(max_min_fair_allocations(&[10, 100], 50), vec![10, 40]);
}

#[test]
fn truncate_fairly_marks_omissions_and_truncations() {
    let msgs = vec![
        serde_json::json!({ "role": "user", "content": "short" }),
        serde_json::json!({ "role": "assistant", "content": "x".repeat(5000) }),
    ];
    let out = truncate_fairly(&msgs, 1000).unwrap();
    assert!(out.contains("short"));
    assert!(out.contains("[... truncated"));
}

#[test]
fn truncate_fairly_returns_none_when_nothing_fits() {
    let msgs = vec![
        serde_json::json!({ "role": "user", "content": "x".repeat(5000) }),
        serde_json::json!({ "role": "assistant", "content": "x".repeat(5000) }),
    ];
    assert!(truncate_fairly(&msgs, 10).is_none());
}

#[test]
fn reduce_budget_halves_then_thirds() {
    assert_eq!(reduce_budget(10000, 1, 10000, 1000), 5000);
    assert_eq!(reduce_budget(5000, 2, 5000, 1000), 1666);
}

#[test]
fn should_compact_at_80_percent() {
    let window = 100;
    let long = serde_json::json!({ "role": "user", "content": "x".repeat(320) });
    assert!(should_compact(&[long], window));

    let short = serde_json::json!({ "role": "user", "content": "hi" });
    assert!(!should_compact(&[short], window));
}

#[test]
fn partition_cuts_at_user_boundary() {
    let msgs = vec![
        serde_json::json!({ "role": "user", "content": "first" }),
        serde_json::json!({ "role": "assistant", "content": "reply" }),
        serde_json::json!({ "role": "user", "content": "second" }),
        serde_json::json!({ "role": "assistant", "content": "reply2" }),
    ];
    let (prefix, suffix) = partition(&msgs, 5);
    assert_eq!(prefix.len(), 2);
    assert_eq!(suffix.len(), 2);
    assert_eq!(suffix[0]["role"], "user");
}

#[test]
fn drop_tool_pairs_drops_tool_noise() {
    let user = serde_json::json!({ "role": "user", "content": "hi" });
    let tool = serde_json::json!({ "role": "tool", "tool_call_id": "c1", "content": "..." });
    let msgs = vec![user.clone(), tool.clone(), tool.clone()];
    let dropped = drop_tool_pairs(&msgs);
    assert_eq!(dropped.len(), 1);
    assert_eq!(dropped[0]["role"], "user");
}

#[test]
fn drop_tool_pairs_below_threshold_keeps() {
    let user = serde_json::json!({ "role": "user", "content": "hi" });
    let tool = serde_json::json!({ "role": "tool", "tool_call_id": "c1", "content": "..." });
    let mut msgs = vec![user; 5];
    msgs.push(tool);
    assert_eq!(drop_tool_pairs(&msgs).len(), 6);
}

// ── Integration ──────────────────────────────────────────────────────────────

struct LongResultTool;

#[async_trait]
impl Tool for LongResultTool {
    fn name(&self) -> &str {
        "long"
    }
    fn description(&self) -> &str {
        "return a long string"
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({ "type": "object" })
    }
    async fn execute(
        &self,
        _input: serde_json::Value,
        _cancel: CancelToken,
    ) -> Result<serde_json::Value, ToolError> {
        Ok(serde_json::json!({ "data": "x".repeat(200) }))
    }
}

#[tokio::test]
async fn compacts_when_context_grows() {
    let provider = Arc::new(ScriptedProvider::new(vec![
        // go1: a tool call returns a long result.
        vec![
            tool_call("c1", "long", serde_json::json!({})),
            end(StopReason::ToolUse),
        ],
        // go1's follow-up turn.
        vec![content("a1"), end(StopReason::EndTurn)],
        // go2's turn boundary: the compaction summarizer call.
        vec![content("[summary]"), end(StopReason::EndTurn)],
        // go2's turn after compaction.
        vec![content("done"), end(StopReason::EndTurn)],
    ]));

    let mut model = Model::new("test-model");
    model.context_window = Some(50);

    let agent = Agent::spawn(AgentConfig {
        agent_id: AgentId("test".into()),
        provider,
        model,
        tools: vec![Arc::new(LongResultTool)],
        hooks: hooks(),
        store: Arc::new(MemStore::default()),
        system_prompt: "test".into(),
        max_retries: 2,
        skill_store: None,
        max_goal_rounds: None,
    });

    let mut rx = agent.subscribe();
    agent.send(user_message("go1")).await.unwrap();
    agent.send(user_message("go2")).await.unwrap();

    let mut events = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            Ok(Ok(AgentEvent::AgentEnd)) => break,
            Ok(Ok(ev)) => events.push(ev),
            Ok(Err(_)) | Err(_) => break,
        }
    }

    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::Compaction { .. }))
    );
    assert!(has_text(&events, "done"));
}
