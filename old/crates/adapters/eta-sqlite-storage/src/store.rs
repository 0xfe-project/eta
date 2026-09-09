//! SQLite-backed `SessionStorage` + a session-directory enumerator.

use std::path::Path;
use std::sync::Mutex;

use async_trait::async_trait;
use eta_core::{SessionEntry, SessionStorage};
use rusqlite::{Connection, params};

/// A single session's SQLite store (one file: `~/.eta/sessions/<uuid>.sqlite`).
///
/// All methods are blocking (SQLite); the async seam wraps them. The `Mutex`
/// serializes access so the store is `Sync` and safe behind an `Arc`.
pub struct SqliteSessionStore {
    conn: Mutex<Connection>,
}

impl SqliteSessionStore {
    /// Open (or create) a session store at `path`.
    pub fn open(path: impl AsRef<Path>) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Open an in-memory store (tests).
    pub fn in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        Self::init(&conn).expect("schema");
        Self {
            conn: Mutex::new(conn),
        }
    }

    /// Access the underlying connection for the time-travel layer.
    pub fn conn(&self) -> &Mutex<Connection> {
        &self.conn
    }

    fn init(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS entries (
                id   INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS kv (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS commits (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                parents  TEXT NOT NULL,       -- JSON array of commit ids
                message  TEXT NOT NULL,
                snapshot TEXT NOT NULL        -- JSON SessionState
            );
            CREATE TABLE IF NOT EXISTS branches (
                name           TEXT PRIMARY KEY,
                head_commit_id INTEGER NOT NULL
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts
                USING fts5(kind, data, content='entries', content_rowid='id');
            CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
                INSERT INTO entries_fts(rowid, kind, data) VALUES (new.id, new.kind, new.data);
            END;
            CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
                INSERT INTO entries_fts(entries_fts, rowid, kind, data)
                    VALUES ('delete', old.id, old.kind, old.data);
            END;
            CREATE VIRTUAL TABLE IF NOT EXISTS commits_fts
                USING fts5(message, snapshot, content='commits', content_rowid='id');
            CREATE TRIGGER IF NOT EXISTS commits_ai AFTER INSERT ON commits BEGIN
                INSERT INTO commits_fts(rowid, message, snapshot)
                    VALUES (new.id, new.message, new.snapshot);
            END;
            CREATE TRIGGER IF NOT EXISTS commits_ad AFTER DELETE ON commits BEGIN
                INSERT INTO commits_fts(commits_fts, rowid, message, snapshot)
                    VALUES ('delete', old.id, old.message, old.snapshot);
            END;
            ",
        )
    }
}

#[async_trait]
impl SessionStorage for SqliteSessionStore {
    async fn load(&self) -> Vec<SessionEntry> {
        let conn = self.conn.lock().unwrap();
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
        rows.filter_map(|r| r.ok())
            .map(|(id, kind, data)| SessionEntry {
                id,
                kind,
                data: serde_json::from_str(&data).unwrap_or(serde_json::Value::Null),
            })
            .collect()
    }

    async fn append(&self, entry: SessionEntry) {
        let conn = self.conn.lock().unwrap();
        let data = serde_json::to_string(&entry.data).unwrap_or_else(|_| "null".into());
        conn.execute(
            "INSERT INTO entries (kind, data) VALUES (?1, ?2)",
            params![entry.kind, data],
        )
        .unwrap();
    }

    async fn checkpoint(&self, state: serde_json::Value) {
        // The latest checkpoint is the working state; time travel snapshots it.
        let data = serde_json::to_string(&state).unwrap_or_else(|_| "null".into());
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM kv WHERE key = '__checkpoint'", [])
            .unwrap();
        conn.execute(
            "INSERT INTO kv (key, value) VALUES ('__checkpoint', ?1)",
            params![data],
        )
        .unwrap();
    }

    async fn search(&self, query: &str) -> Vec<u64> {
        let conn = self.conn.lock().unwrap();
        // Wrap as a phrase so hyphens / punctuation aren't parsed as FTS5 operators.
        let phrase = format!("\"{}\"", query.replace('"', "\"\""));
        let mut stmt = conn
            .prepare("SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?1")
            .unwrap();
        let rows = stmt
            .query_map(params![phrase], |row| row.get::<_, i64>(0))
            .unwrap();
        rows.filter_map(|r| r.ok()).map(|id| id as u64).collect()
    }

    async fn get_state(&self, key: &str) -> Option<serde_json::Value> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT value FROM kv WHERE key = ?1", params![key], |row| {
            row.get::<_, String>(0)
        })
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    }

    async fn set_state(&self, key: &str, value: serde_json::Value) {
        let data = serde_json::to_string(&value).unwrap_or_else(|_| "null".into());
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO kv (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, data],
        )
        .unwrap();
    }

    async fn delete_state(&self, key: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM kv WHERE key = ?1", params![key])
            .unwrap();
    }

    async fn list_state_keys(&self) -> Vec<String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT key FROM kv ORDER BY key").unwrap();
        let rows = stmt.query_map([], |row| row.get::<_, String>(0)).unwrap();
        rows.filter_map(|r| r.ok()).collect()
    }
}

/// Enumerate `*.sqlite` session files in `dir`, returning the ids (filename
/// without extension). Non-recursive; `--resume` / `bootstrap_loops` use this.
pub fn list_sessions_in(dir: &Path) -> std::io::Result<Vec<String>> {
    let mut ids = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("sqlite") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                ids.push(stem.to_string());
            }
        }
    }
    ids.sort();
    Ok(ids)
}
