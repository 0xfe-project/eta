//! Mid-loop summarization: compressing the context as it approaches the window.

use async_trait::async_trait;

use super::*;

/// A tool that returns a long string, to push the context over the threshold.
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
async fn summarizes_when_context_grows() {
    // Four tool calls grow the context past the threshold, then the mid-loop
    // summarizer compresses the prefix before the final turn.
    let mut attempts: Vec<Vec<Result<Event, ProviderError>>> = (0..4)
        .map(|i| {
            vec![
                tool_call(&format!("c{i}"), "long", serde_json::json!({})),
                end(StopReason::ToolUse),
            ]
        })
        .collect();
    attempts.push(vec![content("[summary]"), end(StopReason::EndTurn)]);
    attempts.push(vec![content("done"), end(StopReason::EndTurn)]);
    let provider = Arc::new(ScriptedProvider::new(attempts));

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
        max_goal_rounds: None,
    });

    let events = collect(&agent, user_message("go")).await;

    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolExecutionStart { name, .. } if name == "long"))
    );
    assert!(has_text(&events, "done"));
}
