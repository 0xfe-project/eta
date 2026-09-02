//! Per-agent store: memory only.

use eta_core::MemoryStore;
use eta_sqlite_storage::{SqliteAgentStore, list_agents_in};

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
fn list_agents_in_enumerates_sqlite_files() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("alice.sqlite"), b"").unwrap();
    std::fs::write(dir.path().join("bob.sqlite"), b"").unwrap();
    std::fs::write(dir.path().join("notes.txt"), b"x").unwrap();
    assert_eq!(
        list_agents_in(dir.path()).unwrap(),
        vec!["alice".to_string(), "bob".to_string()]
    );
}
