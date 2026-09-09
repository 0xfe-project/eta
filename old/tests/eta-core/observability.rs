//! Observability: the dev event stream (`subscribe_dev`).

use eta_core::{AgentDevEvent, dev_category};

use super::*;

#[tokio::test]
async fn dev_stream_emits_turn_and_usage() {
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![content("hello"), end(StopReason::EndTurn)],
        vec![content("{}")],
    ]));
    let agent = make_agent(provider, vec![]);
    let mut dev = agent.subscribe_dev();

    let _events = collect(&agent, user_message("hi")).await;

    let mut dev_events: Vec<AgentDevEvent> = Vec::new();
    while let Ok(ev) = dev.try_recv() {
        dev_events.push(ev);
    }

    // Turn + prompt + usage + lifecycle are all present.
    assert!(
        dev_events
            .iter()
            .any(|e| e.category == dev_category::TURN && e.action == "start")
    );
    assert!(
        dev_events
            .iter()
            .any(|e| e.category == dev_category::TURN && e.action == "end")
    );
    assert!(
        dev_events
            .iter()
            .any(|e| e.category == dev_category::USAGE && e.action == "delta")
    );
    assert!(
        dev_events
            .iter()
            .any(|e| e.category == dev_category::PROMPT && e.action == "assembled")
    );
    assert!(
        dev_events
            .iter()
            .any(|e| e.category == dev_category::LIFECYCLE && e.action == "spawn")
    );
}

#[tokio::test]
async fn dev_stream_emits_tool_crud() {
    let calls = Arc::new(AtomicUsize::new(0));
    let tool: Arc<dyn Tool> = Arc::new(CountingTool {
        calls: calls.clone(),
    });

    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![
            tool_call(
                "t1",
                "update_todos",
                serde_json::json!({ "todos": [{ "id": "a", "content": "x", "status": "in_progress" }] }),
            ),
            end(StopReason::ToolUse),
        ],
        vec![content("done"), end(StopReason::EndTurn)],
        vec![content("{}")],
    ]));
    let agent = make_agent(provider, vec![tool]);
    let mut dev = agent.subscribe_dev();

    let _events = collect(&agent, user_message("hi")).await;

    let mut dev_events: Vec<AgentDevEvent> = Vec::new();
    while let Ok(ev) = dev.try_recv() {
        dev_events.push(ev);
    }

    assert!(
        dev_events
            .iter()
            .any(|e| e.category == dev_category::TODO && e.action == "update")
    );
    assert!(
        dev_events
            .iter()
            .any(|e| e.category == dev_category::TOOL && e.action == "start")
    );
}
