//! Per-agent store: memory + persona.

use eta_core::MemoryStore;
use eta_sqlite_storage::SqliteAgentStore;

#[tokio::test]
async fn memory_roundtrip_and_remove() {
    let store = SqliteAgentStore::in_memory();
    store
        .apply(&serde_json::json!({
            "add_new_decision": ["never nextjs"],
            "learn_new_lesson": ["read errors first"]
        }))
        .await
        .unwrap();

    let memory = store.load().await;
    assert_eq!(memory.len(), 2);

    // Remove the decision by id, keep the lesson.
    let decision_id = memory
        .iter()
        .find(|(_, e)| e.content == "never nextjs")
        .map(|(id, _)| *id)
        .unwrap();
    store
        .apply(&serde_json::json!({ "remove_memory_ids": [decision_id] }))
        .await
        .unwrap();

    let memory = store.load().await;
    assert_eq!(memory.len(), 1);
    assert!(memory.values().all(|e| e.content == "read errors first"));
}

#[tokio::test]
async fn memory_apply_over_cap_fails() {
    let store = SqliteAgentStore::in_memory();
    let huge = "x".repeat(20_001);
    let res = store
        .apply(&serde_json::json!({ "learn_new_lesson": [huge] }))
        .await;
    assert!(res.is_err());
    assert!(store.load().await.is_empty());
}

#[test]
fn persona_upsert_and_load() {
    let store = SqliteAgentStore::in_memory();
    store.set_persona("thinker", "# You are a thinker");
    assert_eq!(store.persona("thinker").unwrap(), "# You are a thinker");
    assert_eq!(store.persona_names(), vec!["thinker"]);

    // Upsert overwrites.
    store.set_persona("thinker", "# thinker v2");
    assert_eq!(store.persona("thinker").unwrap(), "# thinker v2");
}
