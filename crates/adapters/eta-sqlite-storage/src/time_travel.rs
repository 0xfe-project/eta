//! Git-like time travel over a SQLite session store: commit DAG + branch
//! pointers. Snapshot = full `SessionState` JSON (all entries + KV).

use std::sync::Mutex;

use rusqlite::{Connection, params};

/// A commit as seen by callers (no snapshot blob — that's pulled on checkout).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BranchInfo {
    pub id: u64,
    pub parents: Vec<u64>,
    pub message: String,
}

/// Time-travel operations over a session's `commits` / `branches` tables.
///
/// The session store owns the `Connection`; this struct borrows it so both can
/// share one file without a second open handle.
pub struct SqliteTimeTravel<'a> {
    conn: &'a Mutex<Connection>,
}

impl<'a> SqliteTimeTravel<'a> {
    pub fn new(conn: &'a Mutex<Connection>) -> Self {
        Self { conn }
    }

    /// Snapshot the whole current session (entries + KV) as JSON.
    fn snapshot(&self) -> serde_json::Value {
        let conn = self.conn.lock().unwrap();
        let mut entries = Vec::new();
        {
            let mut stmt = conn
                .prepare("SELECT id, kind, data FROM entries ORDER BY id")
                .unwrap();
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)? as u64,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .unwrap();
            for r in rows.flatten() {
                entries.push(serde_json::json!({
                    "id": r.0,
                    "kind": r.1,
                    "data": serde_json::from_str::<serde_json::Value>(&r.2)
                        .unwrap_or(serde_json::Value::Null),
                }));
            }
        }
        let mut kv = serde_json::Map::new();
        {
            let mut stmt = conn.prepare("SELECT key, value FROM kv").unwrap();
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .unwrap();
            for r in rows.flatten() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&r.1) {
                    kv.insert(r.0, v);
                }
            }
        }
        serde_json::json!({ "entries": entries, "kv": kv })
    }

    /// Restore the session to `snapshot` (overwrites entries + KV).
    fn restore(&self, snapshot: &serde_json::Value) {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute("DELETE FROM entries", []).unwrap();
        tx.execute("DELETE FROM kv", []).unwrap();
        if let Some(entries) = snapshot.get("entries").and_then(|e| e.as_array()) {
            for e in entries {
                let id = e.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
                let kind = e.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                let data = e
                    .get("data")
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "null".into());
                tx.execute(
                    "INSERT INTO entries (id, kind, data) VALUES (?1, ?2, ?3)",
                    params![id as i64, kind, data],
                )
                .unwrap();
            }
        }
        if let Some(kv) = snapshot.get("kv").and_then(|k| k.as_object()) {
            for (k, v) in kv {
                tx.execute(
                    "INSERT INTO kv (key, value) VALUES (?1, ?2)",
                    params![k, v.to_string()],
                )
                .unwrap();
            }
        }
        tx.commit().unwrap();
    }

    /// Fork a branch pointing at the current HEAD (does not copy state).
    pub fn fork(&self, name: &str, head: u64) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO branches (name, head_commit_id) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET head_commit_id = excluded.head_commit_id",
            params![name, head as i64],
        )
        .unwrap();
    }

    /// Store a snapshot as a new commit with `message`, returning the commit id.
    /// `parents` is the DAG parent list (empty = root).
    pub fn commit(&self, message: &str, parents: &[u64]) -> u64 {
        let snap = self.snapshot();
        let parents_json = serde_json::to_string(parents).unwrap_or_else(|_| "[]".into());
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO commits (parents, message, snapshot) VALUES (?1, ?2, ?3)",
            params![parents_json, message, snap.to_string()],
        )
        .unwrap();
        conn.last_insert_rowid() as u64
    }

    /// Set a branch's HEAD to `commit_id`.
    pub fn set_branch_head(&self, name: &str, commit_id: u64) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE branches SET head_commit_id = ?1 WHERE name = ?2",
            params![commit_id as i64, name],
        )
        .unwrap();
    }

    /// The HEAD commit id of a branch.
    pub fn branch_head(&self, name: &str) -> Option<u64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT head_commit_id FROM branches WHERE name = ?1",
            params![name],
            |row| row.get::<_, i64>(0),
        )
        .ok()
        .map(|v| v as u64)
    }

    /// Checkout a commit (by id): restore its snapshot.
    pub fn checkout(&self, commit_id: u64) {
        let snap = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                "SELECT snapshot FROM commits WHERE id = ?1",
                params![commit_id as i64],
                |row| row.get::<_, String>(0),
            )
            .ok()
        };
        if let Some(snap) = snap {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&snap) {
                self.restore(&v);
            }
        }
    }

    /// Rollback to `commit_id` (alias of checkout).
    pub fn rollback(&self, commit_id: u64) {
        self.checkout(commit_id);
    }

    /// Commit history along the first-parent chain from `head`.
    pub fn history(&self, head: u64) -> Vec<BranchInfo> {
        let conn = self.conn.lock().unwrap();
        let mut out = Vec::new();
        let mut cur = Some(head);
        while let Some(id) = cur {
            let row = conn
                .query_row(
                    "SELECT parents, message FROM commits WHERE id = ?1",
                    params![id as i64],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .ok();
            let Some((parents, message)) = row else {
                break;
            };
            let parents: Vec<u64> = serde_json::from_str(&parents).unwrap_or_default();
            out.push(BranchInfo {
                id,
                parents: parents.clone(),
                message,
            });
            cur = parents.first().copied();
        }
        out
    }

    /// Merge another branch into a new two-parent commit over `base`.
    pub fn merge(&self, message: &str, base: u64, other: u64) -> u64 {
        self.commit(message, &[base, other])
    }

    /// Full-text search over commit snapshots (FTS5).
    pub fn search_commits(&self, query: &str) -> Vec<u64> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id FROM commits WHERE snapshot LIKE ?1 ORDER BY id")
            .unwrap();
        let like = format!("%{query}%");
        let rows = stmt
            .query_map(params![like], |row| row.get::<_, i64>(0))
            .unwrap();
        rows.filter_map(|r| r.ok()).map(|v| v as u64).collect()
    }
}
