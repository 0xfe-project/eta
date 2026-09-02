//! SessionStorage: entries + KV + checkpoint + search + list_sessions.

use eta_core::{SessionEntry, SessionStorage, entry_kind};
use eta_sqlite_storage::{SqliteSessionStore, list_sessions_in};

#[tokio::test]
async fn append_and_load_roundtrip() {
    let store = SqliteSessionStore::in_memory();
    store
        .append(SessionEntry {
            id: 0,
            kind: entry_kind::USER_MESSAGE.into(),
            data: serde_json::json!({ "content": "hello" }),
        })
        .await;

    let entries = store.load().await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].kind, entry_kind::USER_MESSAGE);
    assert_eq!(entries[0].data["content"], "hello");
    assert!(entries[0].id >= 1, "sqlite autoincrements the id");
}

#[tokio::test]
async fn kv_set_get_delete_list() {
    let store = SqliteSessionStore::in_memory();
    store.set_state("a", serde_json::json!({"n": 1})).await;
    store.set_state("b", serde_json::json!("x")).await;

    assert_eq!(
        store.get_state("a").await,
        Some(serde_json::json!({"n": 1}))
    );
    assert_eq!(store.list_state_keys().await, vec!["a", "b"]);

    store.delete_state("a").await;
    assert!(store.get_state("a").await.is_none());
}

#[tokio::test]
async fn checkpoint_persists_to_kv() {
    let store = SqliteSessionStore::in_memory();
    store.checkpoint(serde_json::json!({"id": "sess-1"})).await;
    assert_eq!(
        store.get_state("__checkpoint").await,
        Some(serde_json::json!({"id": "sess-1"}))
    );
}

#[tokio::test]
async fn fts5_search_finds_entries() {
    let store = SqliteSessionStore::in_memory();
    store
        .append(SessionEntry {
            id: 0,
            kind: entry_kind::USER_MESSAGE.into(),
            data: serde_json::json!({ "content": "never use nextjs" }),
        })
        .await;
    store
        .append(SessionEntry {
            id: 0,
            kind: entry_kind::ASSISTANT_MESSAGE.into(),
            data: serde_json::json!({ "content": "ok" }),
        })
        .await;

    let ids = store.search("nextjs").await;
    assert_eq!(ids.len(), 1);
}

#[tokio::test]
async fn list_sessions_enumerates_directory() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("abc.sqlite"), b"").unwrap();
    std::fs::write(dir.path().join("def.sqlite"), b"").unwrap();
    std::fs::write(dir.path().join("notes.txt"), b"").unwrap();

    let ids = list_sessions_in(dir.path()).unwrap();
    assert_eq!(ids, vec!["abc", "def"]);
}
