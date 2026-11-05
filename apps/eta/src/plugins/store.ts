/**
 * The plugins' rows: git sources, sealed values, lowered levels, who enables what, and the audit.
 *
 * Values are sealed as one JSON document per plugin, whatever is in it: which fields are secrets is
 * the manifest's to say, and it can change under the row with an upgrade.
 */
import type { PluginAgentLevel, PluginValue } from "@eta/client-contracts";
import type { Database } from "bun:sqlite";
import type { Buffer } from "node:buffer";
import { seal, unseal } from "../secret";

export interface GitSourceRow {
  name: string;
  repo: string;
  rev: string;
  path: string;
  sha: string;
  ref: string | null;
}

export interface AuditRow {
  id: number;
  at: number;
  sessionId: string;
  agentId: string | null;
  plugin: string;
  field: string;
  level: PluginAgentLevel;
}

export type PluginValues = Record<string, PluginValue>;

export class PluginRows {
  readonly #db: Database;
  readonly #key: Buffer;

  constructor(db: Database, key: Buffer) {
    this.#db = db;
    this.#key = key;
  }

  /* ---------------------------------------------------------------- sources */

  sources(): GitSourceRow[] {
    return this.#db
      .query<GitSourceRow, []>(
        "SELECT name, repo, rev, path, sha, ref FROM plugin_source ORDER BY name",
      )
      .all();
  }

  source(name: string): GitSourceRow | undefined {
    return (
      this.#db
        .query<GitSourceRow, [string]>(
          "SELECT name, repo, rev, path, sha, ref FROM plugin_source WHERE name = ?",
        )
        .get(name) ?? undefined
    );
  }

  saveSource(row: GitSourceRow): void {
    this.#db
      .query(
        `INSERT INTO plugin_source (name, repo, rev, path, sha, ref, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET sha = excluded.sha, ref = excluded.ref`,
      )
      .run(row.name, row.repo, row.rev, row.path, row.sha, row.ref, Date.now());
  }

  removeSource(name: string): void {
    this.#db.query("DELETE FROM plugin_source WHERE name = ?").run(name);
  }

  /* ----------------------------------------------------------------- values */

  /** What was saved for a plugin; a blob that does not open reads as nothing saved. */
  values(plugin: string): PluginValues {
    const row = this.#db
      .query<{ sealed: Uint8Array }, [string]>(
        "SELECT sealed FROM plugin_config WHERE plugin = ?",
      )
      .get(plugin);
    if (row === null) return {};
    const text = unseal(this.#key, row.sealed);
    return text === undefined ? {} : (JSON.parse(text) as PluginValues);
  }

  /** Changes when the values do: what a session's stamp names, in place of the values. */
  configuredAt(plugin: string): number {
    return (
      this.#db
        .query<{ updated_at: number }, [string]>(
          "SELECT updated_at FROM plugin_config WHERE plugin = ?",
        )
        .get(plugin)?.updated_at ?? 0
    );
  }

  saveValues(plugin: string, values: PluginValues): void {
    this.#db
      .query(
        `INSERT INTO plugin_config (plugin, sealed, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (plugin) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at`,
      )
      .run(plugin, seal(this.#key, JSON.stringify(values)), Date.now());
  }

  /* ----------------------------------------------------------------- levels */

  levels(plugin: string): Record<string, PluginAgentLevel> {
    return Object.fromEntries(
      this.#db
        .query<{ field: string; level: PluginAgentLevel }, [string]>(
          "SELECT field, level FROM plugin_agent_level WHERE plugin = ?",
        )
        .all(plugin)
        .map((row) => [row.field, row.level]),
    );
  }

  /** `null` goes back to what the manifest declares. */
  saveLevel(
    plugin: string,
    field: string,
    level: PluginAgentLevel | null,
  ): void {
    if (level === null) {
      this.#db
        .query("DELETE FROM plugin_agent_level WHERE plugin = ? AND field = ?")
        .run(plugin, field);
      return;
    }
    this.#db
      .query(
        `INSERT INTO plugin_agent_level (plugin, field, level) VALUES (?, ?, ?)
         ON CONFLICT (plugin, field) DO UPDATE SET level = excluded.level`,
      )
      .run(plugin, field, level);
  }

  /* ----------------------------------------------------------------- agents */

  enabled(agentId: string): string[] {
    return this.#db
      .query<{ plugin: string }, [string]>(
        "SELECT plugin FROM agent_plugin WHERE agent_id = ? ORDER BY plugin",
      )
      .all(agentId)
      .map((row) => row.plugin);
  }

  agentsOf(plugin: string): string[] {
    return this.#db
      .query<{ agent_id: string }, [string]>(
        "SELECT agent_id FROM agent_plugin WHERE plugin = ? ORDER BY agent_id",
      )
      .all(plugin)
      .map((row) => row.agent_id);
  }

  setEnabled(agentId: string, plugins: readonly string[]): void {
    this.#db.transaction(() => {
      this.#db
        .query("DELETE FROM agent_plugin WHERE agent_id = ?")
        .run(agentId);
      for (const plugin of new Set(plugins))
        this.#db
          .query("INSERT INTO agent_plugin (agent_id, plugin) VALUES (?, ?)")
          .run(agentId, plugin);
    })();
  }

  /* ------------------------------------------------------------------ audit */

  audit(entry: Omit<AuditRow, "id" | "at">): void {
    this.#db
      .query(
        "INSERT INTO plugin_audit (at, session_id, agent_id, plugin, field, level) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        Date.now(),
        entry.sessionId,
        entry.agentId,
        entry.plugin,
        entry.field,
        entry.level,
      );
  }

  /** The latest reads, newest first. */
  audits(limit: number): AuditRow[] {
    return this.#db
      .query<AuditRow, [number]>(
        `SELECT id, at, session_id AS sessionId, agent_id AS agentId, plugin, field, level
           FROM plugin_audit ORDER BY id DESC LIMIT ?`,
      )
      .all(limit);
  }
}
