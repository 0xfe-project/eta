//! Tool argument validation against the tool's JSON Schema.

use super::*;

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
    let agent = make_agent(provider, vec![]);
    let events = collect(&agent, user_message("go")).await;

    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolExecutionEnd { is_error: true, .. }))
    );
}
