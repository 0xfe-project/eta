//! Evo: memory finalization tool + signoff.

use std::collections::BTreeMap;

use eta_core::{Agent, AgentConfig, AgentEvent, AgentId, MemoryEntry, MemoryKind, render_memory};

use super::*;

#[test]
fn renders_memory_block() {
    let mut memory = BTreeMap::new();
    memory.insert(
        1,
        MemoryEntry {
            kind: MemoryKind::Decision,
            content: "never nextjs".into(),
        },
    );
    memory.insert(
        2,
        MemoryEntry {
            kind: MemoryKind::Lesson,
            content: "read errors first".into(),
        },
    );
    let out = render_memory(&memory);
    assert!(out.contains("<memory>"));
    assert!(out.contains("[decision] never nextjs"));
    assert!(out.contains("[lesson] read errors first"));
}

#[tokio::test]
async fn evo_tool_writes_memory() {
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![
            tool_call(
                "e1",
                "evo",
                serde_json::json!({
                    "add_new_decision": ["never nextjs"],
                    "learn_new_lesson": ["read errors first"]
                }),
            ),
            end(StopReason::ToolUse),
        ],
        vec![content("done"), end(StopReason::EndTurn)],
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
        max_goal_rounds: None,
    });
    let _events = collect(&agent, user_message("hi")).await;

    let saved = store.get_state("eta.memory").await.unwrap();
    let memory: BTreeMap<u64, MemoryEntry> = serde_json::from_value(saved).unwrap();
    assert_eq!(memory.len(), 2);
    assert!(memory.values().any(|e| e.content == "never nextjs"));
    assert!(memory.values().any(|e| e.content == "read errors first"));
}

#[tokio::test]
async fn agent_must_call_evo_to_end() {
    // First reply has no evo → the agent injects a signoff reminder, and the
    // model then calls evo (empty args) to finalize.
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![content("hi"), end(StopReason::EndTurn)],
        vec![
            tool_call("e1", "evo", serde_json::json!({})),
            end(StopReason::ToolUse),
        ],
        vec![content("done"), end(StopReason::EndTurn)],
    ]));
    let agent = make_agent(provider, vec![]);
    let events = collect(&agent, user_message("hi")).await;

    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolExecutionStart { name, .. } if name == "evo"))
    );
    assert!(has_text(&events, "done"));
}

#[tokio::test]
async fn evo_add_fails_over_cap() {
    let huge = "x".repeat(20_001);
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![
            tool_call(
                "e1",
                "evo",
                serde_json::json!({ "add_new_decision": [huge] }),
            ),
            end(StopReason::ToolUse),
        ],
        vec![content("done"), end(StopReason::EndTurn)],
    ]));
    let agent = make_agent(provider, vec![]);
    let events = collect(&agent, user_message("hi")).await;

    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolExecutionEnd { is_error: true, .. }))
    );
}
