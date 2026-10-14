"""Atomically rebuild existing vectors when the configured embedder changes."""

import logging

from psycopg import sql

logger = logging.getLogger(__name__)


def reindex(pool, embedder) -> None:
    dimensions = embedder.config.embedding_dims
    with pool.connection() as connection, connection.transaction():
        connection.execute("SELECT pg_advisory_xact_lock(8320768)")
        connection.execute(
            """CREATE TABLE IF NOT EXISTS axp_embedding (
                singleton boolean PRIMARY KEY CHECK (singleton),
                fingerprint text NOT NULL,
                dimensions integer NOT NULL
            )"""
        )
        current = connection.execute(
            "SELECT fingerprint, dimensions FROM axp_embedding WHERE singleton"
        ).fetchone()
        if current == (embedder.fingerprint, dimensions):
            return
        for table in ("memories", "memories_entities"):
            exists = connection.execute("SELECT to_regclass(%s)", (table,)).fetchone()[
                0
            ]
            if exists is None:
                continue
            identifier = sql.Identifier(table)
            connection.execute(
                sql.SQL("LOCK TABLE {} IN ACCESS EXCLUSIVE MODE").format(identifier)
            )
            vector_type = connection.execute(
                """SELECT format_type(atttypid, atttypmod) FROM pg_attribute
                WHERE attrelid = %s::regclass AND attname = 'vector'""",
                (table,),
            ).fetchone()[0]
            if vector_type != f"vector({dimensions})":
                connection.execute(
                    sql.SQL("DROP INDEX IF EXISTS {}").format(
                        sql.Identifier(f"{table}_hnsw_idx")
                    )
                )
                # A failed request rolls back the column and all its vectors.
                connection.execute(
                    sql.SQL(
                        "ALTER TABLE {} ALTER COLUMN vector TYPE vector({}) USING NULL"
                    ).format(identifier, sql.Literal(dimensions))
                )
            count = 0
            with connection.cursor(name=f"reindex_{table}") as cursor:
                cursor.execute(
                    sql.SQL("SELECT id, payload->>'data' FROM {} ORDER BY id").format(
                        identifier
                    )
                )
                while rows := cursor.fetchmany(32):
                    if any(not isinstance(text, str) or not text for _, text in rows):
                        raise ValueError("Cannot re-embed a memory without its text")
                    vectors = embedder.embed_batch([text for _, text in rows])
                    if len(vectors) != len(rows):
                        raise ValueError("Embedding batch size mismatch")
                    with connection.cursor() as writer:
                        writer.executemany(
                            sql.SQL("UPDATE {} SET vector = %s WHERE id = %s").format(
                                identifier
                            ),
                            [
                                (vector, row[0])
                                for vector, row in zip(vectors, rows, strict=True)
                            ],
                        )
                    count += len(rows)
            if dimensions <= 2000:
                connection.execute(
                    sql.SQL(
                        "CREATE INDEX IF NOT EXISTS {} ON {} "
                        "USING hnsw (vector vector_cosine_ops)"
                    ).format(sql.Identifier(f"{table}_hnsw_idx"), identifier)
                )
            logger.info("Re-embedded %d records in %s", count, table)
        connection.execute(
            """INSERT INTO axp_embedding VALUES (true, %s, %s)
            ON CONFLICT (singleton) DO UPDATE SET
            fingerprint = EXCLUDED.fingerprint, dimensions = EXCLUDED.dimensions""",
            (embedder.fingerprint, dimensions),
        )
