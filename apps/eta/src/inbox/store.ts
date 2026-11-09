/**
 * The interactions: the questions agents' sessions asked, and what became of each.
 *
 * The row is the durable half of an ask. The session that asked is parked on a promise inside its
 * ask channel; this table is what a client reads to know a question exists, and what a restart
 * reads to know it is over (nothing survives a restart that could still answer it).
 */
import type {
  InboxResponse,
  InteractionStatus,
  InteractionView,
} from "@eta/client-contracts";
import type { Database } from "bun:sqlite";

/** How long a settled question is kept, counted from the moment it was settled. */
const INTERACTION_RETENTION_DAYS = 30;

interface Row {
  id: string;
  session_id: string;
  question_id: string;
  agent_id: string | null;
  conversation_id: string | null;
  reply_id: string | null;
  prompt: string;
  options: string;
  multi: number;
  status: string;
  answer: string | null;
  relay_of: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

/** A column that holds JSON can hold anything; a bad one degrades to nothing. */
function parse<T>(
  raw: string | null,
  valid: (value: unknown) => boolean,
): T | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return valid(value) ? (value as T) : null;
  } catch {
    return null;
  }
}

const viewOf = (row: Row): InteractionView => ({
  id: row.id,
  sessionId: row.session_id,
  questionId: row.question_id,
  agentId: row.agent_id,
  conversationId: row.conversation_id,
  replyId: row.reply_id,
  prompt: row.prompt,
  options:
    parse<string[]>(
      row.options,
      (value) =>
        Array.isArray(value) && value.every((item) => typeof item === "string"),
    ) ?? [],
  multi: row.multi === 1,
  status: row.status as InteractionStatus,
  answer: parse<InboxResponse>(
    row.answer,
    (value) =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { kind?: unknown }).kind === "string",
  ),
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** The row a question has: one per (session, question), whatever else the session asks. */
export function interactionId(sessionId: string, questionId: string): string {
  return `${sessionId}:${questionId}`;
}

export interface NewInteraction {
  sessionId: string;
  questionId: string;
  prompt: string;
  options: readonly string[];
  multi: boolean;
  agentId: string | null;
  conversationId: string | null;
  replyId: string | null;
}

export class InteractionStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * A question is being asked now. Asking one a session already asked finds its row: still
   * waiting, it is left as it is; settled, the new ask starts it over, because somebody is
   * waiting on it again.
   */
  open(input: NewInteraction): InteractionView {
    const id = interactionId(input.sessionId, input.questionId);
    const now = Date.now();
    this.#db
      .query(
        `INSERT INTO interaction
           (id, session_id, question_id, agent_id, conversation_id, reply_id, prompt, options, multi,
            status, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           reply_id = excluded.reply_id, prompt = excluded.prompt, options = excluded.options,
           multi = excluded.multi, status = 'pending', answer = NULL,
           revision = interaction.revision + 1, updated_at = excluded.updated_at
         WHERE interaction.status <> 'pending'`,
      )
      .run(
        id,
        input.sessionId,
        input.questionId,
        input.agentId,
        input.conversationId,
        input.replyId,
        input.prompt,
        JSON.stringify(input.options),
        input.multi ? 1 : 0,
        now,
        now,
      );
    return this.get(id)!;
  }

  /**
   * Nobody is waiting any more. Only a pending question settles: one that already ended keeps the
   * way it ended, and `undefined` says nothing changed.
   */
  settle(
    id: string,
    status: Exclude<InteractionStatus, "pending">,
    answer: InboxResponse | null = null,
  ): InteractionView | undefined {
    const changed = this.#db
      .query(
        `UPDATE interaction
            SET status = ?, answer = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(
        status,
        answer === null ? null : JSON.stringify(answer),
        Date.now(),
        id,
      ).changes;
    return changed === 0 ? undefined : this.get(id);
  }

  /**
   * A restarted process finds questions nobody can answer: the runs that asked them died with
   * the last one. Returns how many it ended.
   */
  expirePending(): number {
    return this.#db
      .query(
        `UPDATE interaction SET status = 'expired', revision = revision + 1, updated_at = ?
          WHERE status = 'pending'`,
      )
      .run(Date.now()).changes;
  }

  /**
   * Drop the settled questions that were settled more than `INTERACTION_RETENTION_DAYS` ago. A
   * question still waiting is never dropped, however old. Returns how many rows went.
   */
  prune(now = Date.now()): number {
    return this.#db
      .query(
        "DELETE FROM interaction WHERE status <> 'pending' AND updated_at < ?",
      )
      .run(now - INTERACTION_RETENTION_DAYS * 24 * 3_600_000).changes;
  }

  get(id: string): InteractionView | undefined {
    const row = this.#db
      .query<Row, [string]>("SELECT * FROM interaction WHERE id = ?")
      .get(id);
    return row === null ? undefined : viewOf(row);
  }

  setRelayOf(
    id: string,
    sourceInteractionId: string,
  ): InteractionView | undefined {
    this.#db
      .query(
        "UPDATE interaction SET relay_of = ? WHERE id = ? AND relay_of IS NULL",
      )
      .run(sourceInteractionId, id);
    return this.get(id);
  }

  relayOf(id: string): string | null {
    return (
      this.#db
        .query<{ relay_of: string | null }, [string]>(
          "SELECT relay_of FROM interaction WHERE id = ?",
        )
        .get(id)?.relay_of ?? null
    );
  }

  relayQuestionOf(sourceInteractionId: string): InteractionView | undefined {
    const row = this.#db
      .query<Row, [string]>(
        `SELECT * FROM interaction WHERE relay_of = ?
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(sourceInteractionId);
    return row === null ? undefined : viewOf(row);
  }

  /** Every question still waiting, newest first. */
  pending(): InteractionView[] {
    return this.#db
      .query<Row, []>(
        "SELECT * FROM interaction WHERE status = 'pending' ORDER BY created_at DESC, id",
      )
      .all()
      .map(viewOf);
  }

  /** The `limit` questions most recently settled, newest first. */
  settled(limit: number): InteractionView[] {
    return this.#db
      .query<Row, [number]>(
        `SELECT * FROM interaction WHERE status <> 'pending'
          ORDER BY updated_at DESC, id LIMIT ?`,
      )
      .all(limit)
      .map(viewOf);
  }
}
