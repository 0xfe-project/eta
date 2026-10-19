/**
 * The GitHub App's rows: the App, the user who authorized it, the logins in flight and the pull
 * requests tasks delivered. Secrets are sealed under the host's key (`../secret`); a blob that
 * does not open (another host's key, or tampering) reads as nothing, so the App reads as not
 * connected and the user connects again.
 */
import type { TaskPullView } from "@eta/client-contracts";
import type { Database } from "bun:sqlite";
import type { Buffer } from "node:buffer";
import { seal, unseal } from "../secret";
import { WEB_URL } from "./api";

/** The GitHub App as saved: what GitHub shows anyone about it. */
export interface App {
  id: number;
  slug: string;
  name: string;
  htmlUrl: string;
  owner: string;
  /** `User` or `Organization`. */
  ownerType: string;
  botId: number;
  clientId: string | null;
}

export const settingsUrl = (app: App): string =>
  app.ownerType === "Organization"
    ? `${WEB_URL}/organizations/${app.owner}/settings/apps/${app.slug}`
    : `${WEB_URL}/settings/apps/${app.slug}`;

export const installUrl = (app: App): string =>
  `${WEB_URL}/apps/${app.slug}/installations/new`;

/** The user who authorized the App, with the token to act for them. */
export interface User {
  login: string;
  id: number;
  accessToken: string;
  /** Epoch seconds; 0 does not expire. */
  expiresAt: number;
  refreshToken: string;
  /** Epoch seconds; 0 does not expire. */
  refreshExpiresAt: number;
}

interface AppRow {
  app_id: number;
  slug: string;
  name: string;
  html_url: string;
  owner: string;
  owner_type: string;
  bot_id: number;
  client_id: string | null;
  private_key: Uint8Array;
  client_secret: Uint8Array | null;
}

export class GithubStore {
  readonly #db: Database;
  readonly #key: Buffer;

  constructor(db: Database, key: Buffer) {
    this.#db = db;
    this.#key = key;
  }

  /* ------------------------------------------------------------------ app */

  #appRow(): AppRow | null {
    return this.#db
      .query<AppRow, []>("SELECT * FROM github_app WHERE id = 1")
      .get();
  }

  /** The App, or nothing before one is created (or when its key no longer opens). */
  app(): App | null {
    const row = this.#appRow();
    if (row === null || unseal(this.#key, row.private_key) === undefined)
      return null;
    return {
      id: row.app_id,
      slug: row.slug,
      name: row.name,
      htmlUrl: row.html_url,
      owner: row.owner,
      ownerType: row.owner_type,
      botId: row.bot_id,
      clientId: row.client_id,
    };
  }

  /** The App's private key, PEM. */
  privateKey(): string | undefined {
    const row = this.#appRow();
    return row === null ? undefined : unseal(this.#key, row.private_key);
  }

  /** The App's client secret, or nothing before the host has it. */
  clientSecret(): string {
    const row = this.#appRow();
    if (row?.client_secret === null || row === null) return "";
    return unseal(this.#key, row.client_secret)?.trim() ?? "";
  }

  saveApp(
    app: App,
    privateKey: string,
    clientSecret: string | undefined,
    now: number,
  ): void {
    this.#db
      .query(
        `INSERT OR REPLACE INTO github_app
           (id, app_id, slug, name, html_url, owner, owner_type, bot_id, client_id,
            private_key, client_secret, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        app.id,
        app.slug,
        app.name,
        app.htmlUrl,
        app.owner,
        app.ownerType,
        app.botId,
        app.clientId,
        seal(this.#key, privateKey),
        clientSecret === undefined || clientSecret === ""
          ? null
          : seal(this.#key, clientSecret),
        now,
      );
  }

  setBot(botId: number): void {
    this.#db.query("UPDATE github_app SET bot_id = ? WHERE id = 1").run(botId);
  }

  setClient(clientId: string, secret: string): void {
    this.#db
      .query(
        "UPDATE github_app SET client_id = ?, client_secret = ? WHERE id = 1",
      )
      .run(clientId, seal(this.#key, secret));
  }

  deleteApp(): void {
    this.#db.query("DELETE FROM github_app WHERE id = 1").run();
  }

  /* ----------------------------------------------------------------- user */

  user(): User | null {
    const row = this.#db
      .query<{ login: string; github_id: number; token: Uint8Array }, []>(
        "SELECT login, github_id, token FROM github_user WHERE id = 1",
      )
      .get();
    if (row === null) return null;
    const text = unseal(this.#key, row.token);
    if (text === undefined) return null;
    try {
      const token = JSON.parse(text) as Omit<User, "login" | "id">;
      return { ...token, login: row.login, id: row.github_id };
    } catch {
      return null;
    }
  }

  saveUser(user: User, now: number): void {
    const { login, id, ...token } = user;
    this.#db
      .query(
        `INSERT OR REPLACE INTO github_user (id, login, github_id, token, updated_at)
         VALUES (1, ?, ?, ?, ?)`,
      )
      .run(login, id, seal(this.#key, JSON.stringify(token)), now);
  }

  deleteUser(): void {
    this.#db.query("DELETE FROM github_user WHERE id = 1").run();
  }

  /* -------------------------------------------------------------- pending */

  addPending(
    state: string,
    kind: "manifest" | "authorization",
    now: number,
    flow: { verifier?: string; redirectUri?: string } = {},
  ): void {
    this.#db
      .query(
        `INSERT INTO github_pending (state, kind, verifier, redirect_uri, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(state, kind, flow.verifier ?? null, flow.redirectUri ?? null, now);
  }

  /** Forget the logins older than `ttlMs`. */
  prunePending(kind: "manifest" | "authorization", now: number, ttlMs: number) {
    this.#db
      .query("DELETE FROM github_pending WHERE kind = ? AND created_at <= ?")
      .run(kind, now - ttlMs);
  }

  /** The login a state belongs to, used up: a state works once. */
  takePending(
    state: string,
    kind: "manifest" | "authorization",
    now: number,
    ttlMs: number,
  ): { verifier: string; redirectUri: string } | undefined {
    const row = this.#db
      .query<
        {
          verifier: string | null;
          redirect_uri: string | null;
          created_at: number;
        },
        [string, string]
      >(
        "SELECT verifier, redirect_uri, created_at FROM github_pending WHERE state = ? AND kind = ?",
      )
      .get(state, kind);
    this.#db.query("DELETE FROM github_pending WHERE state = ?").run(state);
    if (row === null || now - row.created_at >= ttlMs) return undefined;
    return {
      verifier: row.verifier ?? "",
      redirectUri: row.redirect_uri ?? "",
    };
  }

  /* ---------------------------------------------------------- task pulls */

  /**
   * The task a conversation's pull request belongs to: the most recently touched task linked to
   * the conversation that is still going. Read from the task board's rows, never written.
   */
  taskOfConversation(conversationId: string): string | undefined {
    const row = this.#db
      .query<{ id: string }, [string]>(
        `SELECT id FROM task
          WHERE conversation_id = ?
            AND status IN ('todo', 'in_progress', 'in_review', 'blocked')
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(conversationId);
    return row?.id;
  }

  linkPull(
    taskId: string,
    pull: { url: string; title: string; number: number },
    now: number,
  ): void {
    this.#db
      .query(
        `INSERT INTO task_pull (task_id, url, title, number, opened_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (task_id, url) DO NOTHING`,
      )
      .run(taskId, pull.url, pull.title, pull.number, now);
  }

  pulls(): TaskPullView[] {
    return this.#db
      .query<
        {
          task_id: string;
          url: string;
          title: string;
          number: number;
          opened_at: number;
        },
        []
      >("SELECT * FROM task_pull ORDER BY opened_at, rowid")
      .all()
      .map((row) => ({
        taskId: row.task_id,
        url: row.url,
        title: row.title,
        number: row.number,
        openedAt: row.opened_at,
      }));
  }
}
