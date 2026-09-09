//! Tool execution: the model calls a tool, then continues.

use super::*;

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

    let agent = make_agent(provider, vec![tool]);
    let events = collect(&agent, user_message("go")).await;

    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolExecutionStart { name, .. } if name == "count"))
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(has_text(&events, "done"));
}
