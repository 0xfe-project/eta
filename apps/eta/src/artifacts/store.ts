/**
 * The artifacts' rows: what exists, which versions it has, and which of them are shared. The
 * bytes are files (`service.ts`); a row is written only once its files are there.
 */
import type { TaskArtifactRef } from "@eta/client-contracts";
import type { Database } from "bun:sqlite";

export interface ArtifactRecord {
  id: string;
  title: string;
  publisherAgentId: string | null;
  taskId: string | null;
  conversationId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface VersionRecord {
  id: string;
  artifactId: string;
  number: number;
  files: number;
  bytes: number;
  size: number;
  createdAt: number;
}

export interface ShareRecord {
  token: string;
  versionId: string;
  createdAt: number;
}

interface ArtifactRow {
  id: string;
  title: string;
  publisher_agent: string | null;
  task_id: string | null;
  conversation_id: string | null;
  created_at: number;
  updated_at: number;
}

interface VersionRow {
  id: string;
  artifact_id: string;
  number: number;
  files: number;
  bytes: number;
  size: number;
  created_at: number;
}

interface ShareRow {
  token: string;
  version_id: string;
  created_at: number;
}

const artifactOf = (row: ArtifactRow): ArtifactRecord => ({
  id: row.id,
  title: row.title,
  publisherAgentId: row.publisher_agent,
  taskId: row.task_id,
  conversationId: row.conversation_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const versionOf = (row: VersionRow): VersionRecord => ({
  id: row.id,
  artifactId: row.artifact_id,
  number: row.number,
  files: row.files,
  bytes: row.bytes,
  size: row.size,
  createdAt: row.created_at,
});

const shareOf = (row: ShareRow): ShareRecord => ({
  token: row.token,
  versionId: row.version_id,
  createdAt: row.created_at,
});

export class ArtifactStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Newest first. */
  list(): ArtifactRecord[] {
    return this.#db
      .query<ArtifactRow, []>(
        "SELECT * FROM artifact ORDER BY updated_at DESC, created_at DESC, id",
      )
      .all()
      .map(artifactOf);
  }

  get(id: string): ArtifactRecord | undefined {
    const row = this.#db
      .query<ArtifactRow, [string]>("SELECT * FROM artifact WHERE id = ?")
      .get(id);
    return row === null ? undefined : artifactOf(row);
  }

  /** Every version of every artifact, newest first within an artifact. */
  versions(): VersionRecord[] {
    return this.#db
      .query<VersionRow, []>(
        "SELECT * FROM artifact_version ORDER BY artifact_id, number DESC",
      )
      .all()
      .map(versionOf);
  }

  versionsOf(artifactId: string): VersionRecord[] {
    return this.#db
      .query<VersionRow, [string]>(
        "SELECT * FROM artifact_version WHERE artifact_id = ? ORDER BY number DESC",
      )
      .all(artifactId)
      .map(versionOf);
  }

  versionById(id: string): VersionRecord | undefined {
    const row = this.#db
      .query<VersionRow, [string]>(
        "SELECT * FROM artifact_version WHERE id = ?",
      )
      .get(id);
    return row === null ? undefined : versionOf(row);
  }

  version(artifactId: string, number: number): VersionRecord | undefined {
    const row = this.#db
      .query<VersionRow, [string, number]>(
        "SELECT * FROM artifact_version WHERE artifact_id = ? AND number = ?",
      )
      .get(artifactId, number);
    return row === null ? undefined : versionOf(row);
  }

  nextNumber(artifactId: string): number {
    return (
      this.#db
        .query<{ n: number }, [string]>(
          "SELECT COALESCE(MAX(number), 0) + 1 AS n FROM artifact_version WHERE artifact_id = ?",
        )
        .get(artifactId)?.n ?? 1
    );
  }

  /**
   * Record a published version, and the artifact it belongs to when it is the first, in one
   * write. `taskId` links an existing artifact to a task when given.
   */
  addVersion(input: {
    artifact: {
      id: string;
      title: string;
      publisherAgentId: string | null;
      taskId: string | null;
      conversationId: string | null;
    };
    isNew: boolean;
    version: Omit<VersionRecord, "createdAt">;
  }): void {
    const now = Date.now();
    const { artifact, version } = input;
    this.#db.transaction(() => {
      if (input.isNew) {
        this.#db
          .query(
            `INSERT INTO artifact (id, title, publisher_agent, task_id, conversation_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            artifact.id,
            artifact.title,
            artifact.publisherAgentId,
            artifact.taskId,
            artifact.conversationId,
            now,
            now,
          );
      } else {
        this.#db
          .query(
            "UPDATE artifact SET title = ?, task_id = ?, updated_at = ? WHERE id = ?",
          )
          .run(artifact.title, artifact.taskId, now, artifact.id);
      }
      this.#db
        .query(
          `INSERT INTO artifact_version (id, artifact_id, number, files, bytes, size, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          version.id,
          version.artifactId,
          version.number,
          version.files,
          version.bytes,
          version.size,
          now,
        );
    })();
  }

  /** Delete an artifact; its versions and their shares go with it. */
  remove(id: string): boolean {
    return (
      this.#db.query("DELETE FROM artifact WHERE id = ?").run(id).changes > 0
    );
  }

  /** The newest version of each artifact published for a task, oldest artifact first. */
  latestOfTask(taskId: string): TaskArtifactRef[] {
    return this.#db
      .query<{ id: string; title: string; version: number }, [string]>(
        `SELECT a.id, a.title, MAX(v.number) AS version
           FROM artifact a JOIN artifact_version v ON v.artifact_id = a.id
          WHERE a.task_id = ?
          GROUP BY a.id
          ORDER BY a.created_at, a.id`,
      )
      .all(taskId)
      .map((row) => ({
        artifactId: row.id,
        title: row.title,
        version: row.version,
      }));
  }

  /* ---------------------------------------------------------------- shares */

  /** Every share that has not been taken back. */
  liveShares(): ShareRecord[] {
    return this.#db
      .query<ShareRow, []>(
        "SELECT * FROM artifact_share WHERE revoked_at IS NULL ORDER BY created_at",
      )
      .all()
      .map(shareOf);
  }

  /** A share by its token, if it has not been taken back. */
  liveShare(token: string): ShareRecord | undefined {
    const row = this.#db
      .query<ShareRow, [string]>(
        "SELECT * FROM artifact_share WHERE token = ? AND revoked_at IS NULL",
      )
      .get(token);
    return row === null ? undefined : shareOf(row);
  }

  liveShareOf(versionId: string): ShareRecord | undefined {
    const row = this.#db
      .query<ShareRow, [string]>(
        "SELECT * FROM artifact_share WHERE version_id = ? AND revoked_at IS NULL",
      )
      .get(versionId);
    return row === null ? undefined : shareOf(row);
  }

  addShare(token: string, versionId: string): ShareRecord {
    const now = Date.now();
    this.#db
      .query(
        "INSERT INTO artifact_share (token, version_id, created_at) VALUES (?, ?, ?)",
      )
      .run(token, versionId, now);
    return { token, versionId, createdAt: now };
  }

  /** Take back a version's shares, for good. False when it had none. */
  revokeShares(versionId: string): boolean {
    return (
      this.#db
        .query(
          "UPDATE artifact_share SET revoked_at = ? WHERE version_id = ? AND revoked_at IS NULL",
        )
        .run(Date.now(), versionId).changes > 0
    );
  }
}
