//! Memory: out-of-band extraction at turn end (the agent never sees it).

use std::collections::BTreeMap;

use eta_core::{MemoryEntry, MemoryKind, render_memory};

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
async fn extract_memory_writes_out_of_band() {
    // The agent answers (no tools). The engine then fires a tool-free extract
    // call at turn end that returns JSON memory edits; those land in the store.
    let memory_json =
        "{\"add_new_decision\":[\"never nextjs\"],\"learn_new_lesson\":[\"read errors first\"]}";
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![content("done"), end(StopReason::EndTurn)],
        vec![content(memory_json)],
    ]));

    let store = Arc::new(MemStore::default());
    let memory_store = Arc::new(MemMemoryStore::default());
    let agent = Agent::spawn(AgentConfig {
        agent_id: AgentId("test".into()),
        provider,
        model: Model::new("test-model"),
        tools: vec![],
        hooks: hooks(),
        store: store.clone(),
        memory_store: memory_store.clone(),
        system_prompt: "test".into(),
        adapter_system_prompt: "".into(),
        max_retries: 2,
        skill_store: None,
    });
    let _events = collect(&agent, user_message("hi")).await;

    let memory = memory_store.load().await;
    assert_eq!(memory.len(), 2);
    assert!(memory.values().any(|e| e.content == "never nextjs"));
    assert!(memory.values().any(|e| e.content == "read errors first"));
}

#[tokio::test]
async fn extract_memory_ignores_non_json() {
    // The extractor replies with prose (not JSON); no memory is written.
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![content("done"), end(StopReason::EndTurn)],
        vec![content("nothing to remember")],
    ]));
    let store = Arc::new(MemStore::default());
    let memory_store = Arc::new(MemMemoryStore::default());
    let agent = Agent::spawn(AgentConfig {
        agent_id: AgentId("test".into()),
        provider,
        model: Model::new("test-model"),
        tools: vec![],
        hooks: hooks(),
        store: store.clone(),
        memory_store: memory_store.clone(),
        system_prompt: "test".into(),
        adapter_system_prompt: "".into(),
        max_retries: 2,
        skill_store: None,
    });
    let _events = collect(&agent, user_message("hi")).await;

    assert!(memory_store.load().await.is_empty());
}

#[tokio::test]
async fn extract_memory_cap_enforced() {
    // Add a 20_001-char lesson → the engine drops the edit (no store write).
    let huge = "x".repeat(20_001);
    let response = format!("{{\"learn_new_lesson\":[\"{huge}\"]}}");
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![content("done"), end(StopReason::EndTurn)],
        vec![content(&response)],
    ]));
    let store = Arc::new(MemStore::default());
    let memory_store = Arc::new(MemMemoryStore::default());
    let agent = Agent::spawn(AgentConfig {
        agent_id: AgentId("test".into()),
        provider,
        model: Model::new("test-model"),
        tools: vec![],
        hooks: hooks(),
        store: store.clone(),
        memory_store: memory_store.clone(),
        system_prompt: "test".into(),
        adapter_system_prompt: "".into(),
        max_retries: 2,
        skill_store: None,
    });
    let _events = collect(&agent, user_message("hi")).await;

    assert!(memory_store.load().await.is_empty());
}
