//! Time-travel commands against a session's SQLite store.
//!
//! Session lifecycle (spawn / resume / registry) lives in
//! `eta-core-controller::session`; this module only keeps the dev-TUI's
//! time-travel command wiring, which needs the concrete sqlite handle.

use eta_sqlite_storage::{SqliteSessionStore, SqliteTimeTravel};

use crate::commands::Command;

/// Apply a time-travel command against a concrete SQLite session store,
/// mutating the caller-owned `head` pointer. Returns a human-readable result
/// line or `None` when the command is not a time-travel operation.
pub fn apply_time_travel(
    store: &SqliteSessionStore,
    head: &mut Option<u64>,
    command: &Command,
) -> Option<String> {
    let tt = SqliteTimeTravel::new(store.conn());
    match command {
        Command::Fork(name) => {
            let current = (*head)?;
            tt.fork(name, current);
            Some(format!("forked {name} at {current}"))
        }
        Command::Commit(message) => {
            let parents: Vec<u64> = head.iter().copied().collect();
            let commit_id = tt.commit(message, &parents);
            *head = Some(commit_id);
            Some(format!("commit {commit_id}"))
        }
        Command::Checkout(reference) => {
            let id = reference
                .parse::<u64>()
                .ok()
                .or_else(|| tt.branch_head(reference))?;
            tt.checkout(id);
            *head = Some(id);
            Some(format!("checked out {id}"))
        }
        Command::Rollback(id) => {
            let id = id.parse::<u64>().ok()?;
            tt.rollback(id);
            *head = Some(id);
            Some(format!("rolled back to {id}"))
        }
        Command::History => {
            let current = (*head)?;
            let lines = tt
                .history(current)
                .into_iter()
                .map(|commit| format!("{} {}", commit.id, commit.message))
                .collect::<Vec<_>>()
                .join("\n");
            Some(lines)
        }
        Command::Merge(branch) => {
            let current = (*head)?;
            let other = tt.branch_head(branch)?;
            let merged = tt.merge(&format!("merge {branch}"), current, other);
            *head = Some(merged);
            Some(format!("merged {merged}"))
        }
        Command::Search(query) => {
            let hits = tt.search_commits(query);
            Some(format!("matches: {hits:?}"))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::apply_time_travel;
    use crate::commands::Command;
    use eta_core::{SessionEntry, SessionStorage, entry_kind};
    use eta_sqlite_storage::SqliteSessionStore;

    #[tokio::test]
    async fn time_travel_commit_and_rollback_restores_entries() {
        let store = SqliteSessionStore::in_memory();
        store
            .append(SessionEntry {
                id: 0,
                kind: entry_kind::USER_MESSAGE.into(),
                data: serde_json::json!({"v": "before"}),
            })
            .await;

        let mut head = None;
        let _ = apply_time_travel(&store, &mut head, &Command::Commit("baseline".into()));
        let commit_id = head.expect("commit created a head");

        store
            .append(SessionEntry {
                id: 0,
                kind: entry_kind::USER_MESSAGE.into(),
                data: serde_json::json!({"v": "after"}),
            })
            .await;

        let result =
            apply_time_travel(&store, &mut head, &Command::Rollback(commit_id.to_string()))
                .expect("rollback");
        assert!(result.contains("rolled back"));
        let entries = store.load().await;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].data["v"], "before");
    }

    #[tokio::test]
    async fn time_travel_history_walks_parent_chain() {
        let store = SqliteSessionStore::in_memory();
        let mut head = None;
        let _ = apply_time_travel(&store, &mut head, &Command::Commit("root".into()));
        let _ = apply_time_travel(&store, &mut head, &Command::Commit("second".into()));
        let history = apply_time_travel(&store, &mut head, &Command::History).expect("history");
        assert!(history.contains("second"));
        assert!(history.contains("root"));
    }
}
