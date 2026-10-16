import type { Database } from "bun:sqlite";
import type { SiteFile } from "./zip";
/**
 * Artifacts: the domain (REFACTOR.md §9, P3.2).
 *
 * What an artifact is: a title, a publisher, and a list of immutable versions — each one a static
 * site that was checked before a byte was stored. What a share is: a token bound to one version,
 * revocable forever. What a preview is: a one-hour capability in the path, because a sandboxed
 * iframe is an opaque origin and cannot present a cookie (AXP measured this; the conclusion is
 * kept).
 *
 * Two failures are told apart because a caller has to act differently on them: a package that is
 * not a site is `InvalidArtifact` (422, nothing stored, the message says what to fix), and a store
 * that failed is `StorageFailed` (424, the half-written version is cleaned up and marked failed).
 */
import { Buffer } from "node:buffer";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ArtifactObjects } from "./objects";
import { InvalidArtifact, readSite } from "./zip";

type VersionStatus = "processing" | "published" | "failed";

export interface ArtifactRecord {
  id: string;
  title: string;
  publisherAgent?: string | undefined;
  publisherComputer?: string | undefined;
  taskId?: string | undefined;
  groupId?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface VersionRecord {
  id: string;
  artifactId: string;
  number: number;
  status: VersionStatus;
  error?: string | undefined;
  files: number;
  bytes: number;
  createdAt: string;
  publishedAt?: string | undefined;
}

export interface ShareRecord {
  token: string;
  versionId: string;
  createdAt: string;
  revokedAt?: string | undefined;
}

export interface ArtifactDetail extends ArtifactRecord {
  versions: VersionRecord[];
  shares: ShareRecord[];
}

/** A version whose bytes could not be written: the caller answers 424 and the version is failed. */
export class StorageFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageFailed";
  }
}

/** A version was attempted by somebody who does not publish this artifact. */
export class NotPublisher extends Error {
  constructor() {
    super("只有原发布者能给这个产物发新版本。");
    this.name = "NotPublisher";
  }
}

export interface PublishInput {
  title: string;
  /** The ZIP itself. */
  archive: Uint8Array;
  /** The artifact to add a version to; absent means a new artifact. */
  artifactId?: string | undefined;
  taskId?: string | undefined;
  groupId?: string | undefined;
  publisherAgent?: string | undefined;
}

export interface ArtifactServiceOptions {
  handle: Database;
  /** Where the bytes go: `<dataDir>/artifacts`. */
  objectsRoot: string;
  /** The file holding the preview capability's key; created on first use, 0600. */
  secretPath: string;
  /** How long a preview capability lasts. AXP used an hour. */
  capabilityMs?: number | undefined;
  /** How long a `processing` version may be left behind by a crash. AXP used an hour. */
  staleMs?: number | undefined;
}

const CAPABILITY_MS = 60 * 60 * 1000;
const STALE_MS = 60 * 60 * 1000;

interface ArtifactRow {
  id: string;
  title: string;
  publisher_agent: string | null;
  publisher_computer: string | null;
  task_id: string | null;
  group_id: string | null;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  artifact_id: string;
  number: number;
  status: string;
  error: string | null;
  files: number;
  bytes: number;
  created_at: string;
  published_at: string | null;
}

interface ShareRow {
  token: string;
  version_id: string;
  created_at: string;
  revoked_at: string | null;
}

const toArtifact = (row: ArtifactRow): ArtifactRecord => ({
  id: row.id,
  title: row.title,
  ...(row.publisher_agent === null
    ? {}
    : { publisherAgent: row.publisher_agent }),
  ...(row.publisher_computer === null
    ? {}
    : { publisherComputer: row.publisher_computer }),
  ...(row.task_id === null ? {} : { taskId: row.task_id }),
  ...(row.group_id === null ? {} : { groupId: row.group_id }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toVersion = (row: VersionRow): VersionRecord => ({
  id: row.id,
  artifactId: row.artifact_id,
  number: row.number,
  status:
    row.status === "published"
      ? "published"
      : row.status === "failed"
        ? "failed"
        : "processing",
  ...(row.error === null ? {} : { error: row.error }),
  files: row.files,
  bytes: row.bytes,
  createdAt: row.created_at,
  ...(row.published_at === null ? {} : { publishedAt: row.published_at }),
});

const toShare = (row: ShareRow): ShareRecord => ({
  token: row.token,
  versionId: row.version_id,
  createdAt: row.created_at,
  ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
});

export class ArtifactService {
  readonly #handle: Database;
  readonly #objects: ArtifactObjects;
  readonly #secretPath: string;
  readonly #capabilityMs: number;
  readonly #staleMs: number;
  #secret: Uint8Array | undefined;

  constructor(options: ArtifactServiceOptions) {
    this.#handle = options.handle;
    this.#objects = new ArtifactObjects(options.objectsRoot);
    this.#secretPath = options.secretPath;
    this.#capabilityMs = options.capabilityMs ?? CAPABILITY_MS;
    this.#staleMs = options.staleMs ?? STALE_MS;
  }

  /**
   * Publish a package: a new artifact, or a new version of one.
   *
   * The order is the whole point. The package is checked first, so a bad one costs nothing and
   * leaves nothing. Then the rows, then the bytes, and only then `published` — a version that is
   * `published` is one whose files a preview can read.
   */
  async publish(
    input: PublishInput,
  ): Promise<{ artifact: ArtifactRecord; version: VersionRecord }> {
    const files: SiteFile[] = readSite(input.archive);
    const now = new Date().toISOString();

    const existing =
      input.artifactId === undefined ? undefined : this.get(input.artifactId);
    if (input.artifactId !== undefined && existing === undefined) {
      throw new InvalidArtifact("没有这个产物。");
    }
    if (existing !== undefined) {
      const mine =
        (existing.publisherAgent ?? undefined) ===
        (input.publisherAgent ?? undefined);
      if (!mine) throw new NotPublisher();
    }

    const artifact =
      existing ??
      this.#createArtifact({
        title: input.title,
        ...(input.publisherAgent === undefined
          ? {}
          : { publisherAgent: input.publisherAgent }),
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
        now,
      });

    // A version left `processing` by a crash is nobody's: clean it before adding another, so the
    // numbers a user sees never include a package that is not there.
    await this.cleanStale(new Date(Date.now()));

    const number = this.#nextNumber(artifact.id);
    const versionId = crypto.randomUUID();
    this.#handle
      .query(
        `INSERT INTO artifact_version (id, artifact_id, number, status, files, bytes, created_at)
         VALUES (?, ?, ?, 'processing', ?, ?, ?)`,
      )
      .run(
        versionId,
        artifact.id,
        number,
        files.length,
        input.archive.byteLength,
        now,
      );

    try {
      await this.#objects.writeVersion({
        artifactId: artifact.id,
        version: number,
        archive: input.archive,
        files,
      });
    } catch (error) {
      await this.#objects
        .removeVersion(artifact.id, number)
        .catch(() => undefined);
      this.#handle
        .query(
          "UPDATE artifact_version SET status = 'failed', error = ? WHERE id = ?",
        )
        .run(error instanceof Error ? error.message : String(error), versionId);
      throw new StorageFailed(
        error instanceof Error ? error.message : String(error),
      );
    }

    this.#handle
      .query(
        "UPDATE artifact_version SET status = 'published', published_at = ? WHERE id = ?",
      )
      .run(new Date().toISOString(), versionId);
    this.#handle
      .query("UPDATE artifact SET updated_at = ? WHERE id = ?")
      .run(now, artifact.id);
    return {
      artifact: this.get(artifact.id)!,
      version: this.#versionById(versionId)!,
    };
  }

  /** Every artifact, newest first, optionally one group's or one task's. */
  list(
    options: { groupId?: string | undefined; taskId?: string | undefined } = {},
  ): ArtifactRecord[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (options.groupId !== undefined) {
      clauses.push("group_id = ?");
      args.push(options.groupId);
    }
    if (options.taskId !== undefined) {
      clauses.push("task_id = ?");
      args.push(options.taskId);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = this.#handle
      .query(`SELECT * FROM artifact${where} ORDER BY updated_at DESC`)
      .all(...args) as ArtifactRow[];
    return rows.map(toArtifact);
  }

  get(id: string): ArtifactRecord | undefined {
    const row = this.#handle
      .query("SELECT * FROM artifact WHERE id = ?")
      .get(id) as ArtifactRow | null;
    return row === null ? undefined : toArtifact(row);
  }

  detail(id: string): ArtifactDetail | undefined {
    const artifact = this.get(id);
    if (artifact === undefined) return undefined;
    return {
      ...artifact,
      versions: this.versions(id),
      shares: this.#sharesOf(id),
    };
  }

  versions(artifactId: string): VersionRecord[] {
    const rows = this.#handle
      .query(
        "SELECT * FROM artifact_version WHERE artifact_id = ? ORDER BY number DESC",
      )
      .all(artifactId) as VersionRow[];
    return rows.map(toVersion);
  }

  version(artifactId: string, number: number): VersionRecord | undefined {
    const row = this.#handle
      .query(
        "SELECT * FROM artifact_version WHERE artifact_id = ? AND number = ?",
      )
      .get(artifactId, number) as VersionRow | null;
    return row === null ? undefined : toVersion(row);
  }

  /** Remove an artifact: its rows go, and so do its bytes. */
  async remove(id: string): Promise<boolean> {
    const removed =
      this.#handle.query("DELETE FROM artifact WHERE id = ?").run(id).changes >
      0;
    if (removed) await this.#objects.removeArtifact(id);
    return removed;
  }

  /** The bytes of one file of a published version. */
  async file(
    artifactId: string,
    number: number,
    name: string,
  ): Promise<Uint8Array | undefined> {
    return await this.#objects.file(artifactId, number, name);
  }

  async archive(
    artifactId: string,
    number: number,
  ): Promise<Uint8Array | undefined> {
    return await this.#objects.archive(artifactId, number);
  }

  /** Share a version publicly. A revoked token stays revoked; this mints a new one. */
  share(artifactId: string, number: number): ShareRecord | undefined {
    const version = this.version(artifactId, number);
    if (version === undefined || version.status !== "published")
      return undefined;
    const token = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    this.#handle
      .query(
        "INSERT INTO artifact_share (token, version_id, created_at) VALUES (?, ?, ?)",
      )
      .run(token, version.id, now);
    return { token, versionId: version.id, createdAt: now };
  }

  /** The live share of a version, if there is one. */
  shareOf(artifactId: string, number: number): ShareRecord | undefined {
    const version = this.version(artifactId, number);
    if (version === undefined) return undefined;
    const row = this.#handle
      .query(
        "SELECT * FROM artifact_share WHERE version_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
      )
      .get(version.id) as ShareRow | null;
    return row === null ? undefined : toShare(row);
  }

  /** Revoke a version's shares: forever, and only its own. */
  revoke(artifactId: string, number: number): boolean {
    const version = this.version(artifactId, number);
    if (version === undefined) return false;
    const changed = this.#handle
      .query(
        "UPDATE artifact_share SET revoked_at = ? WHERE version_id = ? AND revoked_at IS NULL",
      )
      .run(new Date().toISOString(), version.id);
    return changed.changes > 0;
  }

  /**
   * What a share token opens: the published version it was minted for, and its artifact.
   *
   * A revoked token is nothing, and a token for a version that failed is nothing either — the
   * check is the same for "never existed" and "no longer valid", because a public page should not
   * tell a stranger which of the two it is.
   */
  byShare(
    token: string,
  ): { artifact: ArtifactRecord; version: VersionRecord } | undefined {
    const row = this.#handle
      .query(
        "SELECT * FROM artifact_share WHERE token = ? AND revoked_at IS NULL",
      )
      .get(token) as ShareRow | null;
    if (row === null) return undefined;
    const version = this.#versionById(row.version_id);
    if (version === undefined || version.status !== "published")
      return undefined;
    const artifact = this.get(version.artifactId);
    return artifact === undefined ? undefined : { artifact, version };
  }

  /** A one-hour capability for private preview: `<version id>.<expires>.<hmac>`. */
  async capability(versionId: string, now: Date = new Date()): Promise<string> {
    const expires = now.getTime() + this.#capabilityMs;
    const body = `${versionId}.${expires}`;
    const signature = await this.#sign(body);
    return `${body}.${signature}`;
  }

  /** What a preview capability opens: that one published version. */
  async byCapability(
    token: string,
    now: Date = new Date(),
  ): Promise<{ artifact: ArtifactRecord; version: VersionRecord } | undefined> {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const [versionId, expires, signature] = parts as [string, string, string];
    const expected = await this.#sign(`${versionId}.${expires}`);
    if (!this.#same(expected, signature)) return undefined;
    if (!/^\d+$/.test(expires) || Number(expires) < now.getTime())
      return undefined;
    const version = this.#versionById(versionId);
    if (version === undefined || version.status !== "published")
      return undefined;
    const artifact = this.get(version.artifactId);
    return artifact === undefined ? undefined : { artifact, version };
  }

  /**
   * Fail the versions a crash left `processing`, and take their bytes away.
   *
   * A version that is `processing` is one nobody can read: it has no preview and no share. Left
   * alone it would keep a number and a prefix forever.
   */
  async cleanStale(now: Date = new Date()): Promise<VersionRecord[]> {
    const cutoff = new Date(now.getTime() - this.#staleMs).toISOString();
    const rows = this.#handle
      .query(
        "SELECT * FROM artifact_version WHERE status = 'processing' AND created_at < ?",
      )
      .all(cutoff) as VersionRow[];
    const stale: VersionRecord[] = [];
    for (const row of rows) {
      await this.#objects
        .removeVersion(row.artifact_id, row.number)
        .catch(() => undefined);
      this.#handle
        .query(
          "UPDATE artifact_version SET status = 'failed', error = ? WHERE id = ? AND status = 'processing'",
        )
        .run("上传中途中断,已清理。", row.id);
      const version = this.#versionById(row.id);
      if (version !== undefined) stale.push(version);
    }
    return stale;
  }

  #createArtifact(input: {
    title: string;
    publisherAgent?: string | undefined;
    taskId?: string | undefined;
    groupId?: string | undefined;
    now: string;
  }): ArtifactRecord {
    const id = crypto.randomUUID();
    this.#handle
      .query(
        `INSERT INTO artifact
           (id, title, publisher_agent, publisher_computer, task_id, group_id, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.publisherAgent ?? null,
        input.taskId ?? null,
        input.groupId ?? null,
        input.now,
        input.now,
      );
    return this.get(id)!;
  }

  #nextNumber(artifactId: string): number {
    const row = this.#handle
      .query(
        "SELECT COALESCE(MAX(number), 0) + 1 AS number FROM artifact_version WHERE artifact_id = ?",
      )
      .get(artifactId) as { number: number };
    return row.number;
  }

  #versionById(id: string): VersionRecord | undefined {
    const row = this.#handle
      .query("SELECT * FROM artifact_version WHERE id = ?")
      .get(id) as VersionRow | null;
    return row === null ? undefined : toVersion(row);
  }

  #sharesOf(artifactId: string): ShareRecord[] {
    const rows = this.#handle
      .query(
        `SELECT s.* FROM artifact_share s
           JOIN artifact_version v ON v.id = s.version_id
          WHERE v.artifact_id = ? ORDER BY s.created_at DESC`,
      )
      .all(artifactId) as ShareRow[];
    return rows.map(toShare);
  }

  /** The capability key: generated on first use, readable only by this user. */
  async #key(): Promise<Uint8Array> {
    if (this.#secret !== undefined) return this.#secret;
    try {
      this.#secret = new Uint8Array(await readFile(this.#secretPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const fresh = randomBytes(32);
      await mkdir(dirname(this.#secretPath), { recursive: true });
      await writeFile(this.#secretPath, fresh, { mode: 0o600 });
      this.#secret = new Uint8Array(fresh);
    }
    return this.#secret;
  }

  async #sign(body: string): Promise<string> {
    const key = await this.#key();
    return createHmac("sha256", key).update(body).digest("hex");
  }

  /** Constant-time comparison, so a capability cannot be guessed one byte at a time. */
  #same(a: string, b: string): boolean {
    const left = Buffer.from(a, "utf8");
    const right = Buffer.from(b, "utf8");
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }
}
