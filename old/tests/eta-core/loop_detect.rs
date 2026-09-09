//! `LoopDetector`: near-duplicate assistant content.

use eta_core::LoopDetector;

#[test]
fn detects_near_duplicate_content() {
    let mut d = LoopDetector::new();
    assert!(!d.observe("the quick brown fox jumps"));
    assert!(!d.observe("the quick brown fox jumps!"));
    assert!(d.observe("the quick brown fox jumps!!"));
}

#[test]
fn ignores_dissimilar_content() {
    let mut d = LoopDetector::new();
    assert!(!d.observe("the quick brown fox"));
    assert!(!d.observe("completely different topic"));
    assert!(!d.observe("yet another unrelated thing"));
}

#[tokio::test]
async fn doom_loop_blocks_third_identical_tool_call() {
    use super::*;

    let calls = Arc::new(AtomicUsize::new(0));
    let tool: Arc<dyn Tool> = Arc::new(CountingTool {
        calls: calls.clone(),
    });

    // The model insists on the exact same call five times, then gives up.
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![
            tool_call("c1", "count", serde_json::json!({"n": 1})),
            end(StopReason::ToolUse),
        ],
        vec![
            tool_call("c2", "count", serde_json::json!({"n": 1})),
            end(StopReason::ToolUse),
        ],
        vec![
            tool_call("c3", "count", serde_json::json!({"n": 1})),
            end(StopReason::ToolUse),
        ],
        vec![content("fine, stopping"), end(StopReason::EndTurn)],
    ]));

    let agent = make_agent(provider, vec![tool]);
    let events = collect(&agent, user_message("go")).await;

    // The third identical call is refused before the tool runs.
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(
        events.iter().any(|e| matches!(e, AgentEvent::LoopDetected)),
        "expected LoopDetected event, got: {events:?}"
    );
}
