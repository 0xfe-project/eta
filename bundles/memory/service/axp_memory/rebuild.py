"""Vector spaces, and rebuilding every vector into a new one.

A space is an embedder and its dimensions (Space). Its memories are a table
of their own (Space.table) and mem0's entities a second one next to it, so
vectors of different spaces never meet in one search. embedding_settings says
which space serves. Changing it rebuilds every vector into the new space's
tables in the background (Rebuilds); recall and saving keep using the current
space until the rebuild has caught up, then switch at once. The rebuild's
state is in the database (embedding_rebuild), so a restart resumes it where
it was.

  prepare   probe the embedder, drop leftovers, create the new tables
  memories  copy the memories, re-embedded, 50 at a time by id
  entities  the same for mem0's entities
  catchup   apply what was saved or forgotten meanwhile (the changes the
            provider records), then, with writes held, the rest and the switch
"""

import logging
import re
import threading
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from . import embedding

logger = logging.getLogger(__name__)

LOCAL = "local"
GATEWAY = "gateway:"
# The local space's table, from before there were others.
LEGACY_TABLE = "memories"
BATCH = 50
# Consecutive failures that pause a rebuild, and how long a pause lasts
# before it tries again.
FAILURES_TO_PAUSE = 5
PAUSE = timedelta(minutes=1)
ACTIVE = ("running", "paused")
NO_ACCOUNT = "没有可用的 Google AI Studio 账号，请先在模型服务中绑定。"
# What the probe embeds.
PROBE = "记忆 embedding 探测 / memory embedding probe"
ZERO_ID = uuid.UUID(int=0)


@dataclass(frozen=True)
class Space:
    # "local" (fastembed) or "gateway:<model>" (the gateway's /v1/embeddings).
    embedder: str
    dims: int

    @property
    def gateway_model(self) -> str | None:
        if self.embedder.startswith(GATEWAY):
            return self.embedder[len(GATEWAY) :]
        return None

    @property
    def table(self) -> str:
        if self == DEFAULT:
            return LEGACY_TABLE
        slug = re.sub(r"[^a-z0-9]+", "_", self.embedder.lower()).strip("_")
        return f"memories_{slug}_{self.dims}"

    def view(self) -> dict:
        return {"model": self.embedder, "dims": self.dims}


DEFAULT = Space(LOCAL, embedding.DIMS)


def parse_space(model, dims) -> Space:
    """The space a request names; ValueError says what is wrong with it."""
    if not isinstance(model, str) or not (
        model == LOCAL or (model.startswith(GATEWAY) and len(model) > len(GATEWAY))
    ):
        raise ValueError("model 应为 local 或 gateway:<模型>。")
    if dims is None:
        dims = embedding.DIMS
    if not isinstance(dims, int) or isinstance(dims, bool):
        raise ValueError("dims 应为整数。")
    if model == LOCAL and dims != embedding.DIMS:
        raise ValueError(f"本地模型只有 {embedding.DIMS} 维。")
    if not 128 <= dims <= 3072:
        raise ValueError("dims 应在 128 到 3072 之间。")
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,80}", model):
        raise ValueError("model 无效。")
    return Space(model, dims)


def entities(table: str) -> str:
    """mem0's entity table next to a memory table."""
    return f"{table}_entities"


SCHEMA = """
CREATE TABLE IF NOT EXISTS embedding_settings (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    embedder text NOT NULL,
    dims integer NOT NULL,
    table_name text NOT NULL,
    -- The space served before the last switch, kept until the next rebuild.
    previous_table text,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS embedding_rebuild (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    job_id uuid NOT NULL,
    embedder text NOT NULL,
    dims integer NOT NULL,
    table_name text NOT NULL,
    status text NOT NULL,
    phase text NOT NULL,
    cursor uuid,
    total integer NOT NULL DEFAULT 0,
    done integer NOT NULL DEFAULT 0,
    failures integer NOT NULL DEFAULT 0,
    error text,
    retry_at timestamptz,
    started_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS embedding_rebuild_changes (
    seq bigserial PRIMARY KEY,
    memory_id uuid NOT NULL,
    op text NOT NULL
);
"""


class Conflict(Exception):
    """The space asked for already serves."""


class Paused(Exception):
    """A failure waiting will not fix soon: the rebuild pauses at once."""


class Rebuilds:
    """The current space and the rebuild into another, for the provider.

    One worker thread runs the rebuild (start); a step at a time, so tests
    drive it with step. One service instance per database: there is no lock
    across processes.
    """

    def __init__(self, provider, *, batch=BATCH, failures_to_pause=FAILURES_TO_PAUSE):
        self.provider = provider
        self.pool = provider.pool
        self.batch = batch
        self.failures_to_pause = failures_to_pause
        # Held to change the job, and by a step while it writes.
        self._lock = threading.RLock()
        self._wake = threading.Event()
        self._stopped = threading.Event()
        # The target space's mem0 instance, for the job that built it.
        self._target: tuple[uuid.UUID, object] | None = None
        with self.pool.connection() as conn:
            conn.execute(SCHEMA)
            row = conn.execute(
                "SELECT embedder, dims FROM embedding_settings"
            ).fetchone()
            if row is None:
                # The memories so far are the local space's.
                conn.execute(
                    "INSERT INTO embedding_settings (embedder, dims, table_name)"
                    " VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                    (DEFAULT.embedder, DEFAULT.dims, DEFAULT.table),
                )
                space = DEFAULT
            else:
                space = Space(row[0], row[1])
        provider.open(space)
        job = self._job()
        if job and job["status"] in ACTIVE:
            provider.on_change = self._record

    # --- The API ------------------------------------------------------------

    def status(self) -> dict:
        job = self._job()
        with self.pool.connection() as conn:
            count = (
                conn.execute(
                    sql.SQL("SELECT count(*) FROM {}").format(
                        sql.Identifier(self.provider.space.table)
                    )
                ).fetchone()[0]
                if _exists(conn, self.provider.space.table)
                else 0
            )
        out = {"space": self.provider.space.view(), "memories": count, "rebuild": None}
        if job:
            out["rebuild"] = {
                "model": job["embedder"],
                "dims": job["dims"],
                "status": job["status"],
                "done": job["done"],
                "total": job["total"],
                "error": job["error"],
                "started_at": job["started_at"].isoformat(),
                "finished_at": job["finished_at"] and job["finished_at"].isoformat(),
            }
        return out

    def start(self, space: Space) -> dict:
        """Rebuild into space, replacing any rebuild under way."""
        with self._lock:
            if space == self.provider.space:
                raise Conflict()
            job = self._job()
            if job and job["status"] in ACTIVE and _space(job) == space:
                return self.status()
            with self.pool.connection() as conn, conn.transaction():
                if job and job["status"] in ACTIVE:
                    self._drop_target(conn, job)
                conn.execute("DELETE FROM embedding_rebuild_changes")
                conn.execute(
                    """
                    INSERT INTO embedding_rebuild
                        (job_id, embedder, dims, table_name, status, phase)
                    VALUES (%s, %s, %s, %s, 'running', 'prepare')
                    ON CONFLICT (id) DO UPDATE SET
                        job_id = EXCLUDED.job_id, embedder = EXCLUDED.embedder,
                        dims = EXCLUDED.dims, table_name = EXCLUDED.table_name,
                        status = 'running', phase = 'prepare', cursor = NULL,
                        total = 0, done = 0, failures = 0, error = NULL,
                        retry_at = NULL, started_at = now(), updated_at = now(),
                        finished_at = NULL
                    """,
                    (uuid.uuid4(), space.embedder, space.dims, space.table),
                )
            self._target = None
            # From now on every write is caught up with later.
            self.provider.on_change = self._record
            logger.info("Rebuilding the memories' vectors into %s", space.table)
        self._wake.set()
        return self.status()

    def cancel(self) -> bool:
        with self._lock:
            job = self._job()
            if not job or job["status"] not in ACTIVE:
                return False
            with self.pool.connection() as conn, conn.transaction():
                self._drop_target(conn, job)
                conn.execute("DELETE FROM embedding_rebuild_changes")
                conn.execute(
                    "UPDATE embedding_rebuild SET status = 'cancelled',"
                    " finished_at = now(), updated_at = now()"
                )
            self._target = None
            self.provider.on_change = None
            logger.info("Cancelled the rebuild into %s", job["table_name"])
        return True

    # --- The worker ---------------------------------------------------------

    def run(self) -> None:
        """Steps until stop; between rebuilds, and while one waits, it sleeps."""
        while not self._stopped.is_set():
            try:
                busy = self.step()
            except Exception:
                logger.exception("Rebuild step failed")
                busy = False
            if not busy:
                self._wake.wait(self._idle_for())
                self._wake.clear()

    def start_worker(self) -> threading.Thread:
        thread = threading.Thread(target=self.run, name="rebuild", daemon=True)
        thread.start()
        return thread

    def stop(self) -> None:
        self._stopped.set()
        self._wake.set()

    def _idle_for(self) -> float:
        job = self._job()
        if job and job["status"] in ACTIVE and job["retry_at"]:
            return max(0.05, (job["retry_at"] - datetime.now(UTC)).total_seconds())
        return 60.0

    def step(self) -> bool:
        """Does the next piece of the rebuild; False when there is none now."""
        job = self._job()
        if not job or job["status"] not in ACTIVE:
            return False
        if job["retry_at"] and job["retry_at"] > datetime.now(UTC):
            return False
        try:
            if job["phase"] == "prepare":
                self._prepare(job)
            elif job["phase"] in ("memories", "entities"):
                self._copy(job)
            else:
                self._catch_up(job)
        except Exception as e:
            self._failed(job, e)
        return True

    def run_to_end(self, limit: int = 10_000) -> dict:
        """Steps until the rebuild ends or waits; for tests."""
        for _ in range(limit):
            if not self.step():
                break
        return self.status()

    # --- Phases -------------------------------------------------------------

    def _prepare(self, job) -> None:
        space = _space(job)
        target = self._target_memory(job)
        try:
            with _as_agent(""):
                vector = target.embedding_model.embed(PROBE, "add")
            if len(vector) != space.dims:
                raise ValueError(f"得到 {len(vector)} 维向量，而不是 {space.dims} 维")
        except Exception as e:
            logger.warning("Embedder %s failed its probe: %s", space.embedder, e)
            self._finish(job, "failed", f"无法使用这个 embedding 模型：{_describe(e)}")
            return
        active = self.provider.space
        with self._lock:
            if not self._current(job):
                return
            with self.pool.connection() as conn, conn.transaction():
                previous = conn.execute(
                    "SELECT previous_table FROM embedding_settings"
                ).fetchone()[0]
                for table in {previous, space.table} - {None, active.table}:
                    _drop(conn, table)
                conn.execute("UPDATE embedding_settings SET previous_table = NULL")
            target.vector_store.create_col()
            target.entity_store.create_col()
            with self.pool.connection() as conn:
                total = sum(
                    conn.execute(
                        sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(t))
                    ).fetchone()[0]
                    for t in (active.table, entities(active.table))
                    if _exists(conn, t)
                )
                conn.execute(
                    "UPDATE embedding_rebuild SET phase = 'memories', cursor = NULL,"
                    " total = %s, done = 0, updated_at = now()",
                    (total,),
                )

    def _copy(self, job) -> None:
        active = self.provider.space
        source = active.table if job["phase"] == "memories" else entities(active.table)
        dest = (
            job["table_name"]
            if job["phase"] == "memories"
            else entities(job["table_name"])
        )
        with self.pool.connection() as conn:
            rows = (
                conn.execute(
                    sql.SQL(
                        "SELECT id, payload FROM {} WHERE id > %s ORDER BY id LIMIT %s"
                    ).format(sql.Identifier(source)),
                    (job["cursor"] or ZERO_ID, self.batch),
                ).fetchall()
                if _exists(conn, source)
                else []
            )
        if not rows:
            with self._lock:
                if self._current(job):
                    with self.pool.connection() as conn:
                        conn.execute(
                            "UPDATE embedding_rebuild SET phase = %s, cursor = NULL,"
                            " updated_at = now()",
                            ("entities" if job["phase"] == "memories" else "catchup",),
                        )
            return
        vectors = self._embed(job, rows)
        with self._lock:
            if not self._current(job):
                return
            with self.pool.connection() as conn, conn.transaction():
                _upsert(conn, dest, rows, vectors)
                conn.execute(
                    "UPDATE embedding_rebuild SET cursor = %s, done = done + %s,"
                    " failures = 0, error = NULL, retry_at = NULL,"
                    " status = 'running', updated_at = now()",
                    (rows[-1][0], len(rows)),
                )

    def _catch_up(self, job) -> None:
        # What was saved or forgotten while the rest was copied, until little
        # is left; then the rest with writes held, and the switch.
        if self._apply_changes(job, limit=self.batch):
            return
        if not self._current(job):
            return
        with self._lock, self.provider.gate.closed():
            if not self._current(job):
                return
            while self._apply_changes(job, limit=self.batch):
                pass
            self._sync_entities(job)
            self._switch(job)

    def _apply_changes(self, job, *, limit) -> bool:
        """Applies up to limit recorded changes; False when there were none."""
        active, table = self.provider.space.table, job["table_name"]
        with self.pool.connection() as conn:
            changes = conn.execute(
                "SELECT seq, memory_id FROM embedding_rebuild_changes"
                " ORDER BY seq LIMIT %s",
                (limit,),
            ).fetchall()
            if not changes:
                return False
            ids = list({memory_id for _, memory_id in changes})
            rows = conn.execute(
                sql.SQL(
                    "SELECT id, payload FROM {} WHERE id = ANY(%s) ORDER BY id"
                ).format(sql.Identifier(active)),
                (ids,),
            ).fetchall()
        vectors = self._embed(job, rows)
        present = {row[0] for row in rows}
        with self._lock:
            if not self._current(job):
                return False
            with self.pool.connection() as conn, conn.transaction():
                _upsert(conn, table, rows, vectors)
                gone = [i for i in ids if i not in present]
                if gone:
                    conn.execute(
                        sql.SQL("DELETE FROM {} WHERE id = ANY(%s)").format(
                            sql.Identifier(table)
                        ),
                        (gone,),
                    )
                conn.execute(
                    "DELETE FROM embedding_rebuild_changes WHERE seq <= %s",
                    (changes[-1][0],),
                )
                conn.execute(
                    "UPDATE embedding_rebuild SET failures = 0, error = NULL,"
                    " retry_at = NULL, status = 'running', updated_at = now()"
                )
        return True

    def _sync_entities(self, job) -> None:
        """mem0 changes its entities itself; the new table follows the old by
        difference. An entity's text never changes, only its links."""
        source, dest = entities(self.provider.space.table), entities(job["table_name"])
        with self.pool.connection() as conn:
            if not _exists(conn, source):
                return
            src, dst = sql.Identifier(source), sql.Identifier(dest)
            missing = conn.execute(
                sql.SQL(
                    "SELECT s.id, s.payload FROM {} s LEFT JOIN {} d ON d.id = s.id"
                    " WHERE d.id IS NULL OR d.payload->>'data' IS DISTINCT FROM"
                    " s.payload->>'data' ORDER BY s.id"
                ).format(src, dst)
            ).fetchall()
        for start in range(0, len(missing), self.batch):
            rows = missing[start : start + self.batch]
            vectors = self._embed(job, rows)
            with self.pool.connection() as conn, conn.transaction():
                _upsert(conn, dest, rows, vectors)
        with self.pool.connection() as conn, conn.transaction():
            conn.execute(
                sql.SQL(
                    "UPDATE {} d SET payload = s.payload FROM {} s"
                    " WHERE d.id = s.id AND d.payload IS DISTINCT FROM s.payload"
                ).format(dst, src)
            )
            conn.execute(
                sql.SQL(
                    "DELETE FROM {} d"
                    " WHERE NOT EXISTS (SELECT 1 FROM {} s WHERE s.id = d.id)"
                ).format(dst, src)
            )

    def _switch(self, job) -> None:
        """With writes held: the new space serves from now on."""
        space, old = _space(job), self.provider.space
        target = self._target_memory(job)
        with self.pool.connection() as conn, conn.transaction():
            conn.execute(
                "UPDATE embedding_settings SET embedder = %s, dims = %s,"
                " table_name = %s, previous_table = %s, updated_at = now()",
                (space.embedder, space.dims, space.table, old.table),
            )
            conn.execute("DELETE FROM embedding_rebuild_changes")
            conn.execute(
                "UPDATE embedding_rebuild SET status = 'done', phase = 'done',"
                " error = NULL, retry_at = NULL, finished_at = now(),"
                " updated_at = now()"
            )
        self.provider.on_change = None
        self.provider.swap(target, space)
        self._target = None
        logger.info("Memories now use %s (%s)", space.table, space.embedder)

    # --- Helpers ------------------------------------------------------------

    def _job(self) -> dict | None:
        with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
            return cur.execute("SELECT * FROM embedding_rebuild").fetchone()

    def _current(self, job) -> bool:
        now = self._job()
        return bool(now and now["job_id"] == job["job_id"] and now["status"] in ACTIVE)

    def _target_memory(self, job):
        if self._target is None or self._target[0] != job["job_id"]:
            self._target = (job["job_id"], self.provider.build(_space(job)))
        return self._target[1]

    def _embed(self, job, rows) -> list:
        """The rows' texts re-embedded, each agent's as that agent's."""
        model = self._target_memory(job).embedding_model
        by_agent = defaultdict(list)
        for i, (_, payload) in enumerate(rows):
            if payload and payload.get("data"):
                by_agent[payload.get("user_id") or ""].append(i)
        vectors = [None] * len(rows)
        for agent, indexes in by_agent.items():
            with _as_agent(agent):
                embedded = model.embed_batch(
                    [rows[i][1]["data"] for i in indexes], "add"
                )
            for i, vector in zip(indexes, embedded, strict=True):
                vectors[i] = [float(x) for x in vector]
        return vectors

    def _record(self, ids: list[str], op: str) -> None:
        with self.pool.connection() as conn:
            with conn.cursor() as cur:
                cur.executemany(
                    "INSERT INTO embedding_rebuild_changes (memory_id, op)"
                    " VALUES (%s, %s)",
                    [(memory_id, op) for memory_id in ids],
                )

    def _failed(self, job, error: Exception) -> None:
        paused = isinstance(error, Paused) or _no_account(error) or _rejected(error)
        failures = job["failures"] + 1
        if paused or failures >= self.failures_to_pause:
            status, retry_at = "paused", datetime.now(UTC) + PAUSE
        else:
            # 1, 2, 4, 8 s...
            status, retry_at = (
                job["status"],
                datetime.now(UTC) + timedelta(seconds=2 ** (failures - 1)),
            )
        message = NO_ACCOUNT if _no_account(error) else _describe(error)
        logger.warning("Rebuild step failed (%d in a row): %s", failures, error)
        with self._lock:
            if not self._current(job):
                return
            with self.pool.connection() as conn:
                conn.execute(
                    "UPDATE embedding_rebuild SET status = %s, failures = %s,"
                    " error = %s, retry_at = %s, updated_at = now()",
                    (status, failures, message, retry_at),
                )

    def _finish(self, job, status: str, error: str | None) -> None:
        with self._lock:
            if not self._current(job):
                return
            with self.pool.connection() as conn:
                conn.execute(
                    "UPDATE embedding_rebuild SET status = %s, error = %s,"
                    " finished_at = now(), updated_at = now()",
                    (status, error),
                )
            self.provider.on_change = None
            self._target = None

    def _drop_target(self, conn, job) -> None:
        if job["table_name"] != self.provider.space.table:
            _drop(conn, job["table_name"])


def _space(job) -> Space:
    return Space(job["embedder"], job["dims"])


def _exists(conn, table: str) -> bool:
    return conn.execute("SELECT to_regclass(%s)", (table,)).fetchone()[0] is not None


def _drop(conn, table: str) -> None:
    for t in (table, entities(table)):
        conn.execute(sql.SQL("DROP TABLE IF EXISTS {}").format(sql.Identifier(t)))


def _upsert(conn, table, rows, vectors) -> None:
    with conn.cursor() as cur:
        cur.executemany(
            sql.SQL(
                "INSERT INTO {} (id, vector, payload)"
                " VALUES (%s, %s::float8[]::vector, %s)"
                " ON CONFLICT (id) DO UPDATE SET vector = EXCLUDED.vector,"
                " payload = EXCLUDED.payload"
            ).format(sql.Identifier(table)),
            [
                (memory_id, vector, Jsonb(payload))
                for (memory_id, payload), vector in zip(rows, vectors, strict=True)
            ],
        )


def _as_agent(agent: str):
    from .mem0_provider import as_agent

    return as_agent(agent)


def _status_code(error: Exception) -> int | None:
    return getattr(error, "status_code", None)


def _no_account(error: Exception) -> bool:
    body = getattr(error, "body", None)
    if isinstance(body, dict) and "error" in body and isinstance(body["error"], dict):
        body = body["error"]
    return (
        _status_code(error) == 503
        and isinstance(body, dict)
        and body.get("code") == "no_account"
    )


def _rejected(error: Exception) -> bool:
    """The gateway refused the request itself; trying again will not help."""
    status = _status_code(error)
    return status is not None and 400 <= status < 500 and status != 429


def _describe(error: Exception) -> str:
    status = _status_code(error)
    message = getattr(error, "message", None) or str(error) or type(error).__name__
    return f"HTTP {status}：{message}" if status else message
