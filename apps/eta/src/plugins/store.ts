/**
 * The plugins' rows: git sources, sealed values, lowered levels, who enables what, and the audit.
 *
 * Values are sealed as one JSON document per plugin, whatever is in it: which fields are secrets is
 * the manifest's to say, and it can change under the row with an upgrade.
 */
import type { PluginAgentLevel, PluginValue } from "@eta/client-contracts";
import type { Database } from "bun:sqlite";
import type { Buffer } from "node:buffer";
import { EncryptedCredentialTable } from "../credentials/table";
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

/**
 * A market source's credential is one row of the host's `credential` table: integration "market",
 * key the source's name, kind "secret", the value a string. A second source takes its own key.
 */
const MARKET_CREDENTIAL = "market";
const CURSOR_SOURCE = "cursor";
const CREDENTIAL_KIND = "secret";

/** A request header the user attached to one of a plugin's remote servers. */
export interface UserHeader {
  server: string;
  name: string;
  value: string;
  secret: boolean;
  /** The user confirmed sending it over plain http to a host that is not this machine. */
  plainOk: boolean;
}

/** A server told to send its sign-in token in a header: the choice only, never a token. */
export interface UserTokenHeader {
  server: string;
  name: string;
  format: "raw" | "bearer";
}

/** An environment variable the user set on one of a plugin's stdio servers. */
export interface UserEnv {
  server: string;
  name: string;
  value: string;
  secret: boolean;
}

export class PluginRows {
  readonly #db: Database;
  readonly #key: Buffer;
  readonly #credentials: EncryptedCredentialTable;

  constructor(db: Database, key: Buffer) {
    this.#db = db;
    this.#key = key;
    this.#credentials = new EncryptedCredentialTable(db, key);
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
    this.#db.query("DELETE FROM plugin_disabled WHERE plugin = ?").run(name);
    this.#db.query("DELETE FROM plugin_header WHERE plugin = ?").run(name);
    this.#db.query("DELETE FROM plugin_env WHERE plugin = ?").run(name);
    this.#db
      .query("DELETE FROM plugin_token_header WHERE plugin = ?")
      .run(name);
  }

  /* --------------------------------------------------------------- the switch */

  /** The plugins switched off for every agent. */
  disabled(): Set<string> {
    return new Set(
      this.#db
        .query<{ plugin: string }, []>("SELECT plugin FROM plugin_disabled")
        .all()
        .map((row) => row.plugin),
    );
  }

  setDisabled(plugin: string, disabled: boolean): void {
    if (disabled)
      this.#db
        .query("INSERT OR IGNORE INTO plugin_disabled (plugin) VALUES (?)")
        .run(plugin);
    else
      this.#db
        .query("DELETE FROM plugin_disabled WHERE plugin = ?")
        .run(plugin);
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

  /** Changes when the values or the user's headers do: what a session's stamp names, in place of them. */
  configuredAt(plugin: string): number {
    return (
      this.#db
        .query<
          { at: number | null },
          [string, string, string, string, string, string, string]
        >(
          `SELECT MAX(
             COALESCE((SELECT updated_at FROM plugin_config WHERE plugin = ?), 0),
             COALESCE((SELECT MAX(updated_at) FROM plugin_header WHERE plugin = ?), 0),
             COALESCE((SELECT MAX(updated_at) FROM plugin_env WHERE plugin = ?), 0),
             COALESCE((SELECT MAX(updated_at) FROM plugin_token_header WHERE plugin = ?), 0),
             COALESCE((SELECT updated_at FROM credential WHERE integration = ? AND key = ? AND kind = ?), 0)
           ) AS at`,
        )
        .get(
          plugin,
          plugin,
          plugin,
          plugin,
          MARKET_CREDENTIAL,
          CURSOR_SOURCE,
          CREDENTIAL_KIND,
        )?.at ?? 0
    );
  }

  /* ----------------------------------------------------------- token headers */

  tokenHeaders(plugin: string): UserTokenHeader[] {
    return this.#db
      .query<UserTokenHeader, [string]>(
        "SELECT server, name, format FROM plugin_token_header WHERE plugin = ? ORDER BY server",
      )
      .all(plugin);
  }

  /** One server's choice; `null` removes it. */
  saveTokenHeader(
    plugin: string,
    server: string,
    header: Omit<UserTokenHeader, "server"> | null,
  ): void {
    this.#db.transaction(() => {
      this.#db
        .query(
          "DELETE FROM plugin_token_header WHERE plugin = ? AND server = ?",
        )
        .run(plugin, server);
      if (header !== null)
        this.#db
          .query(
            "INSERT INTO plugin_token_header (plugin, server, name, format, updated_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(plugin, server, header.name, header.format, Date.now());
    })();
  }

  /* ---------------------------------------------------------------- headers */

  /** The headers the user attached, by server then name; one whose blob does not open is left out. */
  headers(plugin: string): UserHeader[] {
    return this.#db
      .query<
        {
          server: string;
          name: string;
          sealed: Uint8Array;
          secret: number;
          plain_ok: number;
        },
        [string]
      >(
        "SELECT server, name, sealed, secret, plain_ok FROM plugin_header WHERE plugin = ? ORDER BY server, name_lc",
      )
      .all(plugin)
      .flatMap((row) => {
        const value = unseal(this.#key, row.sealed);
        return value === undefined
          ? []
          : [
              {
                server: row.server,
                name: row.name,
                value,
                secret: row.secret === 1,
                plainOk: row.plain_ok === 1,
              },
            ];
      });
  }

  /** The whole set of one server's headers: what is not in `headers` is gone. */
  saveHeaders(
    plugin: string,
    server: string,
    headers: readonly UserHeader[],
  ): void {
    const now = Date.now();
    this.#db.transaction(() => {
      this.#db
        .query("DELETE FROM plugin_header WHERE plugin = ? AND server = ?")
        .run(plugin, server);
      for (const header of headers)
        this.#db
          .query(
            `INSERT INTO plugin_header (plugin, server, name_lc, name, sealed, secret, plain_ok, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            plugin,
            server,
            header.name.toLowerCase(),
            header.name,
            seal(this.#key, header.value),
            header.secret ? 1 : 0,
            header.plainOk ? 1 : 0,
            now,
          );
    })();
  }

  /* ------------------------------------------------------ cursor credential */

  /** The credential saved for a market source; undefined when there is none or its row does not open. */
  marketCredential(source: string): string | undefined {
    const value = this.#credentials.read(
      MARKET_CREDENTIAL,
      source,
      CREDENTIAL_KIND,
    );
    return typeof value === "string" ? value : undefined;
  }

  saveMarketCredential(source: string, value: string): void {
    this.#credentials.write(MARKET_CREDENTIAL, source, CREDENTIAL_KIND, value);
  }

  /** The Cursor credential saved for the host; undefined when there is none or its blob does not open. */
  cursorCredential(): string | undefined {
    return this.marketCredential(CURSOR_SOURCE);
  }

  saveCursorCredential(value: string): void {
    this.saveMarketCredential(CURSOR_SOURCE, value);
  }

  /* -------------------------------------------------------------------- env */

  /** The variables the user set on stdio servers, by server then name; one whose blob does not open is left out. */
  env(plugin: string): UserEnv[] {
    return this.#db
      .query<
        { server: string; name: string; sealed: Uint8Array; secret: number },
        [string]
      >(
        "SELECT server, name, sealed, secret FROM plugin_env WHERE plugin = ? ORDER BY server, name",
      )
      .all(plugin)
      .flatMap((row) => {
        const value = unseal(this.#key, row.sealed);
        return value === undefined
          ? []
          : [
              {
                server: row.server,
                name: row.name,
                value,
                secret: row.secret === 1,
              },
            ];
      });
  }

  /** The whole set of one server's variables: what is not in `env` is gone. */
  saveEnv(plugin: string, server: string, env: readonly UserEnv[]): void {
    const now = Date.now();
    this.#db.transaction(() => {
      this.#db
        .query("DELETE FROM plugin_env WHERE plugin = ? AND server = ?")
        .run(plugin, server);
      for (const one of env)
        this.#db
          .query(
            `INSERT INTO plugin_env (plugin, server, name, sealed, secret, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            plugin,
            server,
            one.name,
            seal(this.#key, one.value),
            one.secret ? 1 : 0,
            now,
          );
    })();
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

  /** What every agent has enabled, one row for each. */
  allEnabled(): { agentId: string; plugin: string }[] {
    return this.#db
      .query<{ agent_id: string; plugin: string }, []>(
        "SELECT agent_id, plugin FROM agent_plugin ORDER BY agent_id, plugin",
      )
      .all()
      .map((row) => ({ agentId: row.agent_id, plugin: row.plugin }));
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
