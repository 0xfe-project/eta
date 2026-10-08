"""The runtime instance's own bookkeeping, in memory.

The ledger records a command before Codex sees it, pending approvals, and an
ordered outbox of events for the control plane. It lives and dies with the
instance: what outlives it is the agent's snapshot.
"""

import json
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS commands (
    command_id TEXT PRIMARY KEY,
    agent_sequence INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    turn_id TEXT,
    error_code TEXT,
    interrupt_requested INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
    approval_id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    method TEXT NOT NULL,
    status TEXT NOT NULL,
    decision TEXT,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
    source_seq INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    acked INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);
"""

# Command statuses. "starting" covers the window between recording intent and
# learning the Codex turn id.
ACCEPTED = "accepted"
STARTING = "starting"
RUNNING = "running"
TERMINAL = {"succeeded", "failed", "interrupted", "outcome_unknown"}


class Ledger:
    def __init__(self):
        self._lock = threading.RLock()
        self._db = sqlite3.connect(
            ":memory:", check_same_thread=False, isolation_level=None
        )
        self._db.row_factory = sqlite3.Row
        self._db.executescript(SCHEMA)

    @contextmanager
    def tx(self):
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                yield self._db
            except BaseException:
                self._db.execute("ROLLBACK")
                raise
            self._db.execute("COMMIT")

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # --- commands -----------------------------------------------------------

    def get_command(self, command_id: str) -> dict | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM commands WHERE command_id=?", (command_id,)
            ).fetchone()
        return _command(row) if row else None

    def accept_command(
        self, command_id: str, *, agent_sequence: int, kind: str, payload: dict
    ) -> dict:
        """Record a command taken from the queue (once; a repeat is a no-op)."""
        now = time.time()
        with self.tx() as db:
            db.execute(
                "INSERT OR IGNORE INTO commands(command_id, agent_sequence, kind, "
                "payload, status, created_at, updated_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?)",
                (
                    command_id,
                    agent_sequence,
                    kind,
                    json.dumps(payload),
                    ACCEPTED,
                    now,
                    now,
                ),
            )
        return self.get_command(command_id)

    def update_command(self, command_id: str, **fields) -> None:
        fields["updated_at"] = time.time()
        assignments = ", ".join(f"{name}=?" for name in fields)
        with self.tx() as db:
            db.execute(
                f"UPDATE commands SET {assignments} WHERE command_id=?",
                (*fields.values(), command_id),
            )

    def next_accepted(self) -> dict | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM commands WHERE status=? ORDER BY agent_sequence LIMIT 1",
                (ACCEPTED,),
            ).fetchone()
        return _command(row) if row else None

    # --- approvals ----------------------------------------------------------

    def add_approval(self, approval_id, command_id, generation, method) -> None:
        with self.tx() as db:
            db.execute(
                "INSERT INTO approvals(approval_id, command_id, generation, method, "
                "status, created_at) VALUES(?, ?, ?, ?, 'pending', ?)",
                (approval_id, command_id, generation, method, time.time()),
            )

    def get_approval(self, approval_id: str) -> dict | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM approvals WHERE approval_id=?", (approval_id,)
            ).fetchone()
        return dict(row) if row else None

    def set_approval(self, approval_id: str, status: str, decision=None) -> None:
        with self.tx() as db:
            db.execute(
                "UPDATE approvals SET status=?, decision=COALESCE(?, decision) "
                "WHERE approval_id=?",
                (status, decision, approval_id),
            )

    # --- outbox -------------------------------------------------------------

    def emit(self, type_: str, payload: dict) -> int:
        with self.tx() as db:
            row = db.execute(
                "SELECT COALESCE(MAX(source_seq), 0) AS seq FROM outbox"
            ).fetchone()
            seq = row["seq"] + 1
            db.execute(
                "INSERT INTO outbox(source_seq, event_id, type, payload, created_at) "
                "VALUES(?, ?, ?, ?, ?)",
                (
                    seq,
                    str(uuid.uuid4()),
                    type_,
                    json.dumps(payload, ensure_ascii=False),
                    time.time(),
                ),
            )
        return seq

    def unacked(self, limit: int, max_bytes: int) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM outbox WHERE acked=0 ORDER BY source_seq LIMIT ?",
                (limit,),
            ).fetchall()
        batch, size = [], 0
        for row in rows:
            size += len(row["payload"]) + 200
            if batch and size > max_bytes:
                break
            batch.append(
                {
                    "source_seq": row["source_seq"],
                    "source_event_id": row["event_id"],
                    "type": row["type"],
                    "payload": json.loads(row["payload"]),
                }
            )
        return batch

    def ack_through(self, source_seq: int) -> None:
        with self.tx() as db:
            db.execute("UPDATE outbox SET acked=1 WHERE source_seq<=?", (source_seq,))

    def all_acked(self) -> bool:
        with self._lock:
            return (
                self._db.execute(
                    "SELECT 1 FROM outbox WHERE acked=0 LIMIT 1"
                ).fetchone()
                is None
            )


def _command(row) -> dict:
    data = dict(row)
    data["payload"] = json.loads(data["payload"])
    data["interrupt_requested"] = bool(data["interrupt_requested"])
    return data
