//! Per-agent SQLite store: memory (and later persona / preferred skills) truth
//! source, keyed by agent name (`~/.eta/agents/<NAME>.sqlite`).

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use async_trait::async_trait;
use eta_core::{MemoryEntry, MemoryStore, apply_memory_edits};
use rusqlite::{Connection, params};

/// A single agent's durable store: memory lives here, not in the session.
pub struct SqliteAgentStore {
    conn: Mutex<Connection>,
}

impl SqliteAgentStore {
    /// Open (or create) an agent store at `path`.
    pub fn open(path: impl AsRef<Path>) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS memory (
                id      INTEGER PRIMARY KEY,
                kind    TEXT NOT NULL,
                content TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS persona (
                name     TEXT PRIMARY KEY,
                content  TEXT NOT NULL
            );
            ",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Open an in-memory agent store (tests).
    pub fn in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS memory (
                id      INTEGER PRIMARY KEY,
                kind    TEXT NOT NULL,
                content TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS persona (
                name     TEXT PRIMARY KEY,
                content  TEXT NOT NULL
            );
            ",
        )
        .expect("schema");
        Self {
            conn: Mutex::new(conn),
        }
    }

    /// Store a persona card (name → markdown body). Upsert.
    pub fn set_persona(&self, name: &str, content: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO persona (name, content) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET content = excluded.content",
            params![name, content],
        )
        .unwrap();
    }

    /// Load a persona card body by name.
    pub fn persona(&self, name: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT content FROM persona WHERE name = ?1",
            params![name],
            |row| row.get::<_, String>(0),
        )
        .ok()
    }

    /// All persona names.
    pub fn persona_names(&self) -> Vec<String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT name FROM persona ORDER BY name")
            .unwrap();
        let rows = stmt.query_map([], |row| row.get::<_, String>(0)).unwrap();
        rows.filter_map(|r| r.ok()).collect()
    }

    fn load_memory_sync(&self) -> BTreeMap<u64, MemoryEntry> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, kind, content FROM memory ORDER BY id")
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
            .map(|(id, kind, content)| {
                let kind = serde_json::from_str(&kind).unwrap_or(eta_core::MemoryKind::Lesson);
                (id, MemoryEntry { kind, content })
            })
            .collect()
    }
}

#[async_trait]
impl MemoryStore for SqliteAgentStore {
    async fn load(&self) -> BTreeMap<u64, MemoryEntry> {
        self.load_memory_sync()
    }

    async fn apply(&self, edits: &serde_json::Value) -> Result<usize, eta_core::ToolError> {
        let mut memory = self.load_memory_sync();
        let total = apply_memory_edits(&mut memory, edits)?;

        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute("DELETE FROM memory", []).unwrap();
        for (id, entry) in &memory {
            let kind = serde_json::to_string(&entry.kind).unwrap_or_else(|_| "\"lesson\"".into());
            tx.execute(
                "INSERT INTO memory (id, kind, content) VALUES (?1, ?2, ?3)",
                params![*id as i64, kind, entry.content],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        Ok(total)
    }
}
