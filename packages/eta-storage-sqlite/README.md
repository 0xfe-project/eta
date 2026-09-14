# @earendil-works/pi-session-backend-sqlite-node

Node `node:sqlite` Session backend for `@earendil-works/pi-agent-core`.

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import {
  createNodeSqliteFactory,
  SqliteSessionRepo,
} from "@earendil-works/pi-session-backend-sqlite-node";

const repository = new SqliteSessionRepo({
  directory: "/var/lib/pi/sessions",
  databaseFactory: createNodeSqliteFactory(),
});

const session = await repository.create({}, BACKGROUND_CONTEXT);
const main = await session.createBranch("main", null, BACKGROUND_CONTEXT);
await main.appendMessage(
  { role: "user", content: "hello", timestamp: Date.now() },
  BACKGROUND_CONTEXT,
);
await session.close(BACKGROUND_CONTEXT);
await repository.close(BACKGROUND_CONTEXT);
```

The default layout creates one file per Session under `directory`. IDs containing only ASCII letters, digits, `_`, and `-` retain `{sessionId}.sqlite`; every other ID uses a `~`-prefixed base64url encoding of its UTF-16 code units. The durable ID is unchanged, and returned/listed metadata contains the canonical physical path. Pass `databasePath` to place multiple Sessions in one supported shared container; its parent is created when needed.

The database factory distinguishes intentional creation, no-create read-write open, and no-create read-only open. Session `open()` and deletion reject metadata outside the configured repository and never create a missing database. Listing is read-only and best-effort. Forking deliberately permits a foreign source metadata path: it reads that exact existing container read-only and never substitutes an active local Session with the same ID.

The host lifecycle, not this backend, guarantees one writable owner per Session. Directly opening the same Session for writes in another process is unsupported. The repository rejects overlapping local create/open/fork/delete ownership for one ID, but implements no cross-process lease, lock, fence, heartbeat, or takeover. The host must close a worker before deletion.

A fork of a source open in the same repository queues its snapshot on that source's commit queue. Any other source, including one held open by a live Session worker, uses an independent read-only connection and one deferred WAL transaction; later worker commits may complete while that snapshot remains open. Shared-container deletion removes only the selected Session's rows. Repository close waits for every open Session cleanup attempt before reporting errors. The package does not export a search service or FTS index; search is the separate S3 projection.

## Schema migrations

`SqliteSessionRepo` automatically applies bundled migrations before creating or
opening a writable session, creating a fork destination, or deleting a session.
This happens on database access after an application update; there is no manual
migration command. Each database container tracks its schema independently in
`PRAGMA user_version`. This number is separate from the application release and
`sessions.storage_version` (the serialized session format).

Existing databases have `user_version = 0`. The idempotent `001_initial.sql`
adopts their existing schema without deleting session data, then pending changes
run in numeric order. A fresh database runs the same complete sequence. Reopening
a current database does not rerun migrations. An application that encounters a
schema newer than its bundled migrations refuses to open it; automatic downgrade
is not supported.

To change a field or table:

1. Add the next consecutive file under `src/sqlite/migrations/`, for example
   `002_add_origin.sql`. Keep released migration files unchanged; numbers must
   start at 1 and contain no gaps or duplicates.
2. Use SQL such as `ALTER TABLE`, including defaults or backfills needed by existing
   rows. Migration files must not manage transactions or `user_version`; the runner
   owns both. Do not put nontransactional operations such as `VACUUM` in them.
3. Test upgrades from the previous schema with populated data, a fresh database,
   repeated opens, and failed upgrades. The migration tests use an isolated SQL
   directory to exercise future field changes without inventing production fields.
4. Ship the SQL files with the build. `scripts/copy-migrations.mjs` copies the full
   directory to `dist/sqlite/migrations/`; no separate registration is necessary.

The runner reads all SQL before taking a `BEGIN IMMEDIATE` lock, then rechecks the
version under that lock. All pending migrations and version updates commit in one
transaction. A SQL failure rolls back the entire upgrade and reports the failing
filename, leaving the database at its previous version for a later retry. This
schema lock does not replace the host's single-writer ownership requirements.

Listing and external fork-source reads remain read-only. Listing reads the stable
`sessions` metadata columns even for older schemas, so old sessions remain
discoverable and can be upgraded by `open()`. Keep these discovery columns readable
in future migrations. Full external fork-source reads require the current schema
(or legacy version 0 while the bundled schema is still version 1); open an outdated
source through its owning repository first. Discovery skips newer/incompatible
files; explicit opens report migration errors.
Direct users of `SqliteStorage` must call the exported `applyMigrations(db)` before
constructing storage, as the synchronous constructor cannot initialize a schema.

The current `eta-server` uses JSONL `FileStorage`, so these migrations apply to
SQLite containers only. They do not convert existing JSONL sessions to SQLite.
