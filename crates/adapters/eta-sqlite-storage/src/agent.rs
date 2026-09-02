//! Per-agent SQLite store: memory truth source, keyed by agent name
//! (`~/.eta/agents/<NAME>.sqlite`). Persona cards live in `eta-system-prompts`
//! and custom `*.persona.md` files, not here.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use async_trait::async_trait;
use eta_core::{MemoryEntry, MemoryStore, apply_memory_edits};
use rusqlite::{Connection, params};

/// Enumerate `*.sqlite` agent files in `dir`, returning agent names (filename
/// without extension). Non-recursive; used by the TUI's agent picker.
pub fn list_agents_in(dir: &Path) -> std::io::Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("sqlite") {
            if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
                names.push(stem.to_string());
            }
        }
    }
    names.sort();
    Ok(names)
}

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
            ",
        )
        .expect("schema");
        Self {
            conn: Mutex::new(conn),
        }
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
