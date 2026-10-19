/**
 * What the database holds about bundles: the values each is configured with (sealed), and the
 * repositories some of them came from.
 *
 * Values are read and written only through here, and only `config` returns them. Everything that
 * goes to a client is made from `has`/`names`, so a secret has no path to the wire.
 */
import type { Database } from "bun:sqlite";
import type { Buffer } from "node:buffer";
import { seal, unseal } from "./seal";

export interface SourceRow {
  name: string;
  repo: string;
  rev: string;
  path: string;
  sha: string;
  fetchedAt: number;
}

interface SourceDb {
  name: string;
  repo: string;
  rev: string;
  path: string;
  sha: string;
  fetched_at: number;
}

export class BundleRows {
  readonly #db: Database;
  readonly #key: Buffer;

  constructor(db: Database, key: Buffer) {
    this.#db = db;
    this.#key = key;
  }

  /** The values of a bundle. A blob this host's key does not open is the same as none. */
  config(name: string): Record<string, string> {
    const row = this.#db
      .query<{ sealed: Uint8Array }, [string]>(
        "SELECT sealed FROM bundle_config WHERE name = ?",
      )
      .get(name);
    if (row === null) return {};
    const text = unseal(this.#key, row.sealed);
    if (text === undefined) return {};
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    } catch {
      return {};
    }
  }

  /** When the values were last written, 0 for a bundle with none; part of a session's stamp. */
  configuredAt(name: string): number {
    return (
      this.#db
        .query<{ updated_at: number }, [string]>(
          "SELECT updated_at FROM bundle_config WHERE name = ?",
        )
        .get(name)?.updated_at ?? 0
    );
  }

  setConfig(name: string, values: Record<string, string>): void {
    if (Object.keys(values).length === 0) {
      this.#db.query("DELETE FROM bundle_config WHERE name = ?").run(name);
      return;
    }
    this.#db
      .query(
        `INSERT INTO bundle_config (name, sealed, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at`,
      )
      .run(name, seal(this.#key, JSON.stringify(values)), Date.now());
  }

  sources(): SourceRow[] {
    return this.#db
      .query<SourceDb, []>("SELECT * FROM bundle_source ORDER BY name")
      .all()
      .map((row) => ({
        name: row.name,
        repo: row.repo,
        rev: row.rev,
        path: row.path,
        sha: row.sha,
        fetchedAt: row.fetched_at,
      }));
  }

  setSource(source: SourceRow): void {
    this.#db
      .query(
        `INSERT INTO bundle_source (name, repo, rev, path, sha, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET repo = excluded.repo, rev = excluded.rev,
           path = excluded.path, sha = excluded.sha, fetched_at = excluded.fetched_at`,
      )
      .run(
        source.name,
        source.repo,
        source.rev,
        source.path,
        source.sha,
        source.fetchedAt,
      );
  }

  removeSource(name: string): void {
    this.#db.query("DELETE FROM bundle_source WHERE name = ?").run(name);
  }
}
