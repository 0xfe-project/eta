//! `multi_tool_use`: run multiple tools in parallel.

use super::*;

#[tokio::test]
async fn multi_tool_use_runs_parallel() {
    let calls = Arc::new(AtomicUsize::new(0));
    let tool: Arc<dyn Tool> = Arc::new(CountingTool {
        calls: calls.clone(),
    });

    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![
            tool_call(
                "m1",
                "multi_tool_use",
                serde_json::json!({
                    "parallel": [
                        { "name": "count", "input": {} },
                        { "name": "count", "input": {} }
                    ]
                }),
            ),
            end(StopReason::ToolUse),
        ],
        vec![
            tool_call("e1", "evo", serde_json::json!({})),
            end(StopReason::ToolUse),
        ],
        vec![content("done"), end(StopReason::EndTurn)],
    ]));

    let agent = make_agent(provider, vec![tool]);
    let _events = collect(&agent, user_message("go")).await;

    assert_eq!(calls.load(Ordering::SeqCst), 2);
}
