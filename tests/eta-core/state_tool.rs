//! The builtin state tools write through to the session store.

use super::*;

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
    let agent = Agent::spawn(AgentConfig {
        agent_id: AgentId("test".into()),
        provider,
        model: Model::new("test-model"),
        tools: vec![],
        hooks: hooks(),
        store: store.clone(),
        system_prompt: "test".into(),
        max_retries: 2,
        skill_store: None,
        max_goal_rounds: None,
    });
    let _events = collect(&agent, user_message("write k")).await;

    assert_eq!(store.get_state("k").await, Some(serde_json::json!("v")));
}
