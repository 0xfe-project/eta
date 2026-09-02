//! Time travel: commit DAG + branch pointers over a session store.

use eta_core::{SessionEntry, SessionStorage, entry_kind};
use eta_sqlite_storage::{SqliteSessionStore, SqliteTimeTravel};

fn store() -> SqliteSessionStore {
    SqliteSessionStore::in_memory()
}

#[tokio::test]
async fn commit_checkout_rollback_restores_snapshot() {
    let store = store();
    store
        .append(SessionEntry {
            id: 0,
            kind: entry_kind::USER_MESSAGE.into(),
            data: serde_json::json!({"v": "before"}),
        })
        .await;

    let tt = SqliteTimeTravel::new(&store.conn());
    let c0 = tt.commit("baseline", &[]);

    // Mutate after the commit.
    store
        .append(SessionEntry {
            id: 0,
            kind: entry_kind::USER_MESSAGE.into(),
            data: serde_json::json!({"v": "after"}),
        })
        .await;

    // Rollback to c0 → "after" is gone.
    tt.rollback(c0);
    let entries = store.load().await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].data["v"], "before");
}

#[tokio::test]
async fn fork_branch_and_history() {
    let store = store();
    store
        .append(SessionEntry {
            id: 0,
            kind: entry_kind::USER_MESSAGE.into(),
            data: serde_json::json!({"v": 1}),
        })
        .await;

    let tt = SqliteTimeTravel::new(&store.conn());
    let c0 = tt.commit("root", &[]);
    let c1 = tt.commit("second", &[c0]);
    tt.fork("feature", c1);

    assert_eq!(tt.branch_head("feature"), Some(c1));
    let hist = tt.history(c1);
    assert_eq!(hist.len(), 2);
    assert_eq!(hist[0].id, c1);
    assert_eq!(hist[1].id, c0);
}

#[tokio::test]
async fn merge_creates_two_parent_commit() {
    let store = store();
    let tt = SqliteTimeTravel::new(&store.conn());
    let a = tt.commit("a", &[]);
    let b = tt.commit("b", &[a]);
    let m = tt.merge("merge b into a", a, b);
    assert_ne!(m, a);
    assert_ne!(m, b);
    let hist = tt.history(m);
    assert_eq!(hist[0].parents, vec![a, b]);
}

#[tokio::test]
async fn search_commits_by_snapshot() {
    let store = store();
    store
        .append(SessionEntry {
            id: 0,
            kind: entry_kind::USER_MESSAGE.into(),
            data: serde_json::json!({"content": "unique-token-xyz"}),
        })
        .await;
    let tt = SqliteTimeTravel::new(&store.conn());
    let c = tt.commit("with token", &[]);

    let hits = tt.search_commits("unique-token-xyz");
    assert!(hits.contains(&c));
}
